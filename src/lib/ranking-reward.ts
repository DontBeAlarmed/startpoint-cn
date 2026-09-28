import { getDb } from "../data/db"
import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getPlayerCharacterSync } from "../data/domains/character"
import {
    getPlayerQuestLocalRankPercentageSync,
    getPlayerSingleQuestProgressSync,
} from "../data/domains/quest"
import { givePlayerDegreeSync } from "../data/domains/degree"
import { grantStoryRewardWithinTransactionSync } from "./story-reward-grant"
import { QuestCategory, RewardType, type CurrencyReward, type EquipmentItemReward, type Reward } from "./types"

/**
 * 排名活动领奖(rank_event/receive_reward)的领域模块。
 *
 * 档位判定与客户端 getRankRating 同源:rank_percentage 为 0-100、越小越强,
 * 取官方领奖表中第一个 rank_border >= rank_percentage/100 的档位行;奖励
 * 发放与档位选行读同一张官方表,保证"客户端展示的档位 = 实际发放的档位"。
 * 领取记录(players_ranking_reward_claims)与奖励发放必须在同一事务中。
 */

export interface RankingRewardSlot {
    kind: number
    id?: number
    amount: number
}

export interface RankingRewardTier {
    rank: number
    multipliedId: number
    rankBorder: number
    reasonId: number
    rewards: RankingRewardSlot[]
}

// GeneralRewardKind(客户端枚举):0=Item 1=Equipment 2=Stone 3=Mana
// 4=PooledExp 5=PassCardPoint 6=Character 7=Degree。Stone 走 BEADS
// (星导石),与 clear_reward 的既有映射一致。
const GENERAL_KIND_ITEM = 0
const GENERAL_KIND_EQUIPMENT = 1
const GENERAL_KIND_STONE = 2
const GENERAL_KIND_MANA = 3
const GENERAL_KIND_POOLED_EXP = 4
const GENERAL_KIND_DEGREE = 7

// 客户端 getSummary dummy 的百分位取值域为 [0.5, 100],0 不在设计包络内
const RANK_PERCENTAGE_MINIMUM = 0.5

const rankingEventIdQuestMap: Record<number, number> = {
    [1]: 1001,
    [2]: 2001,
    [3]: 3001,
    [4]: 4001,
    [5]: 5001,
    [1000]: 1000001,
    [1001]: 1001001,
}

export interface RankingPlacement {
    questId: number
    bestElapsedTimeMs: number | null
    highScore: number | null
    leaderCharacterId: number
    leaderEvolutionLevel: number
    rankPercentage: number
    rankBorderTop: {
        elapsed_time_ms: number
        is_accomplished: boolean
        score: number
    } | null
}

/**
 * 参赛判定与百分位(get_summary 显示与领奖发放共用的唯一来源)。
 * 返回 null 表示未参赛或记录不可用,对应摘要 best_record: null / 领奖 status 3。
 */
export function getRankingPlacement(
    playerId: number,
    eventId: number,
): RankingPlacement | null {
    const questId = rankingEventIdQuestMap[eventId]
    if (questId === undefined) return null

    const progress = getPlayerSingleQuestProgressSync(playerId, QuestCategory.RANKING_EVENT_SINGLE, questId)
    if (progress === null
        || (progress.bestElapsedTimeMs === undefined && progress.highScore === undefined)) return null

    const leaderCharacterId = progress.leaderCharacterId
    if (!Number.isSafeInteger(leaderCharacterId) || leaderCharacterId! <= 0) return null
    const leaderCharacter = getPlayerCharacterSync(playerId, leaderCharacterId!)
    const rawPercentage = getPlayerQuestLocalRankPercentageSync(playerId, QuestCategory.RANKING_EVENT_SINGLE, questId)
    if (leaderCharacter === null || rawPercentage === null) return null
    // 并列第一名会算出精确的 0,而客户端结果动画在该输入下计算 ranks[-1] 崩溃
    // (F1009,rate 恰为 1.0);客户端离线 dummy 的合法输入域为 [0.5, 100],取其下界。
    // 0.5 仍落在最小档位边界(3%)之内,不改变任何档位与发放。
    const rankPercentage = Math.max(rawPercentage, RANK_PERCENTAGE_MINIMUM)

    return {
        questId,
        bestElapsedTimeMs: progress.bestElapsedTimeMs ?? null,
        highScore: progress.highScore ?? null,
        leaderCharacterId: leaderCharacterId!,
        leaderEvolutionLevel: leaderCharacter.evolutionLevel,
        rankPercentage,
        rankBorderTop: getRankingTopRecord(questId),
    }
}

/**
 * 榜首参考线(rank_border_top):本服当前真实的第一名记录,排序口径与百分位
 * 一致(有完成耗时者优先按耗时升序,未完成排后按分数降序)。客户端的排名表
 * 与结果弹窗按该字段绘制榜首标记,官方系实现(含客户端离线 dummy)恒以
 * 非空对象下发;单人时即玩家自己的成绩(自己就是第一名,语义自洽)。
 */
function getRankingTopRecord(questId: number): RankingPlacement["rankBorderTop"] {
    const top = getDb().prepare(`
        SELECT best_elapsed_time_ms, high_score
        FROM players_quest_progress
        WHERE section = ? AND quest_id = ?
            AND (best_elapsed_time_ms IS NOT NULL OR high_score IS NOT NULL)
        ORDER BY
            CASE WHEN best_elapsed_time_ms IS NULL THEN 1 ELSE 0 END,
            best_elapsed_time_ms ASC,
            high_score DESC
        LIMIT 1
    `).get(QuestCategory.RANKING_EVENT_SINGLE, questId) as {
        best_elapsed_time_ms: number | null
        high_score: number | null
    } | undefined
    if (top === undefined) return null
    const isAccomplished = top.best_elapsed_time_ms !== null
    return {
        elapsed_time_ms: isAccomplished ? top.best_elapsed_time_ms! : 0,
        is_accomplished: isAccomplished,
        score: top.high_score ?? 0,
    }
}

export function getRankingEventQuestId(eventId: number): number | undefined {
    return rankingEventIdQuestMap[eventId]
}

/**
 * 档位选行:复刻客户端 getRankRating 的比较方向(首个 border >= p/100,
 * 溢出取最低档)。输入的 rankPercentage 必须与下发给客户端的摘要同源。
 */
export function selectRankingRewardTier(
    tiers: readonly RankingRewardTier[],
    rankPercentage: number,
): RankingRewardTier {
    const ratio = rankPercentage / 100
    return tiers.find(tier => tier.rankBorder >= ratio) ?? tiers[tiers.length - 1]
}

function getRankingRewardTiers(eventId: number): RankingRewardTier[] | null {
    const table = getContentSnapshot().repository.table<Record<string, RankingRewardTier[]>>(
        "ranking_event_ranking_reward.json",
    )
    const tiers = table[String(eventId)]
    if (tiers === undefined || tiers.length === 0) return null
    return tiers
}

function buildRankingSummaryPayload(placement: RankingPlacement): Record<string, unknown> {
    const isAccomplished = placement.bestElapsedTimeMs !== null
    return {
        "best_record": {
            "elapsed_time_ms": isAccomplished ? placement.bestElapsedTimeMs : 0,
            "is_accomplished": isAccomplished,
            "score": placement.highScore ?? 0,
        },
        "leader_character_evolution_img_level": placement.leaderEvolutionLevel,
        "leader_character_id": placement.leaderCharacterId,
        "rank_border_top": placement.rankBorderTop,
        "rank_percentage": placement.rankPercentage,
    }
}

export function getRankingSummaryPayload(playerId: number, eventId: number): Record<string, unknown> {
    const placement = getRankingPlacement(playerId, eventId)
    if (placement === null) return { best_record: null }
    return buildRankingSummaryPayload(placement)
}

function generalRewardSlotToReward(slot: RankingRewardSlot): Reward {
    switch (slot.kind) {
        case GENERAL_KIND_ITEM:
        case GENERAL_KIND_EQUIPMENT: {
            const equipmentLike: EquipmentItemReward = {
                type: slot.kind === GENERAL_KIND_ITEM ? RewardType.ITEM : RewardType.EQUIPMENT,
                id: slot.id!,
                count: slot.amount,
            }
            return equipmentLike
        }
        case GENERAL_KIND_STONE:
            return currencyReward(RewardType.BEADS, slot.amount)
        case GENERAL_KIND_MANA:
            return currencyReward(RewardType.MANA, slot.amount)
        case GENERAL_KIND_POOLED_EXP:
            return currencyReward(RewardType.EXP, slot.amount)
        default:
            throw new Error(`Unsupported ranking reward kind: ${slot.kind}`)
    }
}

function currencyReward(type: RewardType, count: number): CurrencyReward {
    return { type, count }
}

export type RankingRewardClaimOutcome = {
    status: 1 | 2
    summary: Record<string, unknown>
}

/**
 * 领取排名奖励:无参赛记录/未知活动返回 null(路由按官方 status=3 应答);
 * 首次领取在同一事务中发放档位奖励并写入领取记录(status=1);已领取过则
 * 只回摘要(status=2),不再发放。发放失败时事务整体回滚,不留下领取记录。
 */
export function claimRankingReward(
    playerId: number,
    eventId: number,
): RankingRewardClaimOutcome | null {
    const placement = getRankingPlacement(playerId, eventId)
    if (placement === null) return null
    const tiers = getRankingRewardTiers(eventId)
    if (tiers === null) return null

    const tier = selectRankingRewardTier(tiers, placement.rankPercentage)
    const summary = buildRankingSummaryPayload(placement)

    return getDb().transaction(() => {
        const claim = getDb().prepare(`
            INSERT OR IGNORE INTO players_ranking_reward_claims (player_id, ranking_event_id, claimed_at)
            VALUES (?, ?, ?)
        `).run(playerId, eventId, Date.now())
        if (claim.changes === 0) return { status: 2 as const, summary }

        for (const slot of tier.rewards) {
            if (slot.kind === GENERAL_KIND_DEGREE) {
                if (slot.id === undefined) throw new Error("Ranking degree reward is missing degree id")
                givePlayerDegreeSync(playerId, slot.id)
                continue
            }
            grantStoryRewardWithinTransactionSync(playerId, generalRewardSlotToReward(slot))
        }
        return { status: 1 as const, summary }
    })()
}
