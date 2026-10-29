import { getDb } from "../data/db"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import {
    getPlayerGrowthFundReceivedIdsSync,
    insertPlayerGrowthFundReceivedSync,
} from "../data/domains/growth-fund"
import { getFinishedPlayerQuestIdsBySectionsSync } from "../data/domains/quest"
import { getGrowthFundTable } from "./growth-fund-content"
import type { GrowthFundKind } from "../content/converters/growth-fund"
import { getPlayerRankLevel } from "./player-rank-content"
import { getMailArrivedSync } from "./mail-notification"
import { mergeCommonResponseFragments } from "./common-response/merge"
import type { CommonResponseFragment } from "./common-response/model"
import {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
} from "./reward-grant"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"
import { RewardType } from "./types/rewards"
import { generateDataHeaders } from "../utils"

// 成长基金（growth_fund）：购买身份为 user_info 恒真布尔（2026-10-29 裁定，
// 不做购买路径），本模块只实现 bonus 领取。条件判定镜像客户端
// GrowthFundItemLogic.canFetch（Laite 三段 rank 门槛 / 主线 section 1 /
// EX section 4 的 finished 关卡）。

export type GrowthFundReceiveRejectionKind =
    | "unknownBonus"
    | "alreadyReceived"
    | "conditionNotMet"

export interface GrowthFundReceiveRejection {
    readonly kind: GrowthFundReceiveRejectionKind
    readonly bonusId: number
}

export interface GrowthFundReceiveSuccess {
    readonly playerId: number
    readonly fundReceiveList: readonly number[]
    readonly paidVmoneyAfter: number
    readonly freeVmoneyAfter: number
    readonly items: Readonly<Record<string, number>>
    readonly mailArrived: boolean
}

export type GrowthFundReceiveResult =
    | { ok: true, result: GrowthFundReceiveSuccess }
    | {
        ok: false
        kind: "rejections"
        rejections: readonly GrowthFundReceiveRejection[]
        message: string
    }
    | { ok: false, kind: "emptyRequest", message: string }

interface AccumulatedRewards {
    paidVmoney: number
    freeVmoney: number
    items: Map<number, number>
}

export function receiveGrowthFundBonusSync(input: {
    readonly playerId: number
    readonly bonusIds: readonly number[]
}): GrowthFundReceiveResult {
    const bonusIds = [...new Set(input.bonusIds)]
    if (bonusIds.length === 0) {
        return { ok: false, kind: "emptyRequest", message: "No bonus ids supplied." }
    }
    if (bonusIds.some(bonusId => !Number.isSafeInteger(bonusId) || bonusId < 1)) {
        return { ok: false, kind: "emptyRequest", message: "Invalid bonus id." }
    }

    return getDb().transaction((): GrowthFundReceiveResult => {
        const player = getPlayerSync(input.playerId)
        if (player === null) {
            return { ok: false, kind: "emptyRequest", message: "Player not found." }
        }
        const table = getGrowthFundTable()
        const received = new Set(getPlayerGrowthFundReceivedIdsSync(input.playerId))
        const rankLevel = getPlayerRankLevel(player.rankPoint)

        // Laite 三段购买身份（恒真裁定下与客户端分段保真一致）；主线/EX 走
        // section 1 / section 4 的 finished 关卡集合。
        const clearedQuests = getFinishedPlayerQuestIdsBySectionsSync(
            input.playerId,
            [1, 4],
        )

        const rejections: GrowthFundReceiveRejection[] = []
        const rewards: AccumulatedRewards = {
            paidVmoney: 0,
            freeVmoney: 0,
            items: new Map(),
        }
        const accepted: number[] = []

        for (const bonusId of bonusIds) {
            const bonus = table[String(bonusId)]
            if (bonus === undefined) {
                rejections.push({ kind: "unknownBonus", bonusId })
                continue
            }
            if (received.has(bonusId)) {
                rejections.push({ kind: "alreadyReceived", bonusId })
                continue
            }
            if (!isConditionMet(bonus.kind, rankLevel, clearedQuests)) {
                rejections.push({ kind: "conditionNotMet", bonusId })
                continue
            }
            accepted.push(bonusId)
            for (const reward of [bonus.reward1, bonus.reward2]) {
                if (reward === null) continue
                if (reward.kind === "stone") {
                    rewards.paidVmoney += bonus.chargeVmoneyNum
                    rewards.freeVmoney += bonus.freeVmoneyNum
                } else {
                    rewards.items.set(
                        reward.itemId,
                        (rewards.items.get(reward.itemId) ?? 0) + reward.count,
                    )
                }
            }
        }

        if (rejections.length > 0) {
            return {
                ok: false,
                kind: "rejections",
                rejections,
                message: `Growth fund bonus rejected: ${rejections.map(
                    rejection => `${rejection.kind}:${rejection.bonusId}`,
                ).join(", ")}`,
            }
        }

        // 石类 free 走共享 BEADS 授予引擎（与登录奖励/定时资源同路，含容量与
        // 溢出策略）；道具同批进入引擎（999003 券等）；paid（当前数据恒 0，
        // 保留官方语义）在事务内直加。
        const plan = createRewardGrantExecutionPlan([
            ...[...rewards.items.entries()].map(([itemId, count]) => ({
                type: RewardType.ITEM as const,
                id: itemId,
                count,
            })),
            ...(rewards.freeVmoney > 0
                ? [{ type: RewardType.BEADS as const, count: rewards.freeVmoney }]
                : []),
        ])
        const rewardResult = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            input.playerId,
            plan,
            {
                playerId: input.playerId,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            { itemOverflow: createRewardGrantItemOverflowPolicy(input.playerId) },
        )
        const paidAfter = player.vmoney + rewards.paidVmoney
        const freeAfter = rewardResult.playerAfter?.freeVmoney
            ?? (player.freeVmoney + rewards.freeVmoney)
        if (rewards.paidVmoney > 0) {
            updatePlayerSync({ id: input.playerId, vmoney: paidAfter })
        }
        for (const bonusId of accepted) {
            insertPlayerGrowthFundReceivedSync(input.playerId, bonusId)
        }

        return {
            ok: true,
            result: {
                playerId: input.playerId,
                // 响应 fund_receive_list = 本次领取批次（客户端对每个元素弹
                // GrowthFund toast，全量累计会把历史已领 id 重弹——双审 P2）
                fundReceiveList: accepted,
                paidVmoneyAfter: paidAfter,
                freeVmoneyAfter: freeAfter,
                items: Object.fromEntries(rewards.items),
                mailArrived: getMailArrivedSync(input.playerId),
            },
        }
    })()
}

function isConditionMet(
    kind: GrowthFundKind,
    rankLevel: number,
    clearedQuests: Record<number, ReadonlySet<number>>,
): boolean {
    if (kind.index === 0) {
        // 购买身份恒真（2026-10-29 裁定），客户端三段布尔选择退化为 rank 门槛；
        // LAITE_MAX_RANK(80)/LAITE_MAX_TREASURY1(180) 分段见 growth-fund-content.ts。
        return rankLevel >= kind.laiteRankThreshold
    }
    if (kind.index === 1) {
        return clearedQuests[1]?.has(kind.mainQuestId) === true
    }
    return clearedQuests[4]?.has(kind.exQuestId) === true
}

export function projectGrowthFundReceiveResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: GrowthFundReceiveSuccess
}): Record<string, unknown> {
    const fragment: CommonResponseFragment = {
        user_info: {
            vmoney: input.result.paidVmoneyAfter,
            free_vmoney: input.result.freeVmoneyAfter,
        },
        character_list: null,
        item_list: input.result.items,
        equipment_list: null,
        mission_info: null,
        over_max: null,
        mail_arrived: input.result.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            fund_receive_list: [...input.result.fundReceiveList],
        },
    }
}
