import type { PlayerQuestProgress } from "../../../data/types"
import { givePlayerDegreeSync } from "../../../data/domains/degree"
import { QuestCategory, RewardType, type CurrencyReward, type PlayerRewardResult, type Reward } from "../../types"
import { buildScoreAttackMainCharacterIds } from "./score-attack-handler"
import type { SoloTimeAttackTimelineTier } from "../solo-time-attack-content"

export interface SoloTimeAttackFinishInput {
    readonly playerId: number
    readonly questId: number
    readonly eventId: number
    readonly soloQuestId: number
    readonly elapsedTimeMs: number
    readonly isAccomplished: boolean
    readonly clearRank: number | null
    readonly party: { characters: ({ id: number | null } | null)[] }
    readonly tiers: readonly SoloTimeAttackTimelineTier[]
}

export interface SoloTimeAttackFinishResult {
    readonly soloTimeAttackEvent: {
        readonly elapsed_time_ms: number
        readonly main_character_ids: Record<number, number>
        readonly new_degree_ids: readonly number[]
        readonly previous_best_elapsed_time_ms: number | null
        readonly previous_best_elapsed_score: null
        readonly reward_ids: readonly number[]
    }
    readonly rewardResult: PlayerRewardResult | null
}

export interface SoloTimeAttackFinishDependencies {
    readonly transaction: <T>(operation: () => T) => T
    readonly getProgress: (playerId: number, category: number, questId: number) => PlayerQuestProgress | null
    readonly insertProgress: (playerId: number, category: number, progress: PlayerQuestProgress) => void
    readonly updateProgress: (playerId: number, category: number, progress: PlayerQuestProgress) => void
    readonly deleteActiveQuest: (playerId: number) => void
    /** Stone 档:直接入账 free_vmoney(BEADS 通道,与 score-attack 同款直授)。 */
    readonly grantRewards: (playerId: number, rewards: readonly Reward[]) => PlayerRewardResult | null
    /** Degree 档(称号):直接授予(carnival 同款域函数)。 */
    readonly grantDegree: (playerId: number, degreeId: number) => void
}

/**
 * 极时试炼(SOLO_TIME_ATTACK_EVENT 25)结算:
 * - 最佳时间 min 追踪(与 score-attack 同一 progress 基础设施,category 维度隔离);
 * - 时间线奖励(帮助 Event_solo_time_attack L41-43「以指定时间通关关卡后即可
 *   领取时间线更新奖励」):通关时间 ≤ 分线阈值即获得该档;最佳时间只减不增,
 *   资格集单调增长 → 每次结算只补发「本次新跨过」的档(以旧最佳为界)。
 *   发放=通关时点直接入账(客户端契约:SingleOrMultiBattleQuestFinishProcess
 *   :299-321 reward_ids>0 → setSoloTimeAttackEventUpdateRecordData 记记账,
 *   随后 QuestSelectScene 走 NewRecordDialog+GeneralRewardListDialog 纯展示、
 *   deleteSoloTimeAttackEventUpdateRecordData——全链路无领取端点,奖励必是
 *   结算时点直授;Stone=free_vmoney(BEADS),Degree=players_degrees):
 * - 响应块(客户端 BattleQuestFinishRealRemote :2257-2373 契约):
 *   elapsed_time_ms[必] / main_character_ids / new_degree_ids(本次新获称号,
 *   驱动客户端 degree toast——SoloTimeAttackNewRecordDialog :744-757) /
 *   previous_best_elapsed_time_ms / previous_best_elapsed_score(恒 None——
 *   时间攻击无分值) / reward_ids(新跨档 id,客户端记账门)。
 */
export function handleSoloTimeAttackEventFinish(
    input: SoloTimeAttackFinishInput,
    dependencies: SoloTimeAttackFinishDependencies,
): SoloTimeAttackFinishResult {
    return dependencies.transaction(() => {
        const previousProgress = dependencies.getProgress(
            input.playerId, QuestCategory.SOLO_TIME_ATTACK_EVENT, input.questId,
        )
        const oldBestMs = previousProgress?.bestElapsedTimeMs ?? null
        const elapsedSeconds = input.elapsedTimeMs / 1000
        const crossedTiers = input.isAccomplished
            ? input.tiers.filter(tier => elapsedSeconds <= tier.clearTimeSeconds
                && (oldBestMs === null || oldBestMs / 1000 > tier.clearTimeSeconds))
            : []
        const leaderCharacterId = input.party.characters[0]?.id ?? undefined

        if (input.isAccomplished) {
            const progress: PlayerQuestProgress = {
                questId: input.questId,
                finished: true,
                highScore: 0,
                clearRank: Math.max(previousProgress?.clearRank ?? 1, input.clearRank ?? 1),
                bestElapsedTimeMs: oldBestMs === null
                    ? input.elapsedTimeMs
                    : Math.min(oldBestMs, input.elapsedTimeMs),
                leaderCharacterId,
            }
            if (previousProgress === null) {
                dependencies.insertProgress(
                    input.playerId, QuestCategory.SOLO_TIME_ATTACK_EVENT, progress,
                )
            } else {
                dependencies.updateProgress(
                    input.playerId, QuestCategory.SOLO_TIME_ATTACK_EVENT, progress,
                )
            }
        }

        let stoneCount = 0
        const newDegreeIds: number[] = []
        for (const tier of crossedTiers) {
            for (const reward of tier.rewards) {
                if (reward.kind === "stone") {
                    stoneCount += reward.count
                } else {
                    dependencies.grantDegree(input.playerId, reward.degreeId)
                    newDegreeIds.push(reward.degreeId)
                }
            }
        }
        const stoneRewards: CurrencyReward[] = stoneCount > 0
            ? [{ type: RewardType.BEADS, count: stoneCount }]
            : []
        const rewardResult = stoneRewards.length > 0
            ? dependencies.grantRewards(input.playerId, stoneRewards)
            : null

        dependencies.deleteActiveQuest(input.playerId)

        return {
            soloTimeAttackEvent: {
                elapsed_time_ms: input.elapsedTimeMs,
                main_character_ids: buildScoreAttackMainCharacterIds(input.party),
                new_degree_ids: newDegreeIds,
                previous_best_elapsed_time_ms: oldBestMs,
                previous_best_elapsed_score: null,
                reward_ids: crossedTiers.map((tier: SoloTimeAttackTimelineTier) => tier.id),
            },
            rewardResult,
        }
    })
}
