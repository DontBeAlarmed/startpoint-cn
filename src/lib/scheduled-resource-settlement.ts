import type { Player } from "../data/types"
import { getDb } from "../data/db"
import { getPlayerItemsByIdsSync } from "../data/domains/item"
import { getPlayerSync } from "../data/domains/player"
import {
    getScheduledResourceStatesByRuleIdsSync,
    listScheduledResourceRulesForPlayerSync,
    recordScheduledResourceGrantsWithinTransactionSync,
    type ScheduledResourceRule,
} from "../data/domains/scheduled-resource"
import { getBusinessDayKey } from "./time-utils"
import {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"
import { RewardType } from "./types/rewards"
import { validateScheduledResourceRuleInput } from "./scheduled-resource-rules"

type SettlementPlayer = Pick<Player, "id" | "freeMana" | "freeVmoney" | "expPool">

export interface ScheduledResourceSettlementInput {
    readonly player: SettlementPlayer
    readonly realNow: Date
    readonly dailyResetHour: number
    readonly itemMaxCount: (itemId: number) => number | null
    readonly maxFreeVmoney: number
}

export type ScheduledResourceSettlementResult =
    | {
        readonly status: "none"
        readonly grantedRuleIds: readonly []
    }
    | {
        readonly status: "granted"
        readonly grantedRuleIds: readonly number[]
        readonly rewardResult: RewardGrantExecutionResult
    }

function isActiveAt(rule: ScheduledResourceRule, nowMs: number): boolean {
    return (rule.startsAtReal === null || rule.startsAtReal.getTime() <= nowMs)
        && (rule.endsAtReal === null || nowMs < rule.endsAtReal.getTime())
}

export function settleScheduledResourcesSync(
    input: ScheduledResourceSettlementInput,
): ScheduledResourceSettlementResult {
    const rules = listScheduledResourceRulesForPlayerSync(input.player.id)
    if (rules.length === 0) return { status: "none", grantedRuleIds: [] }

    const nowMs = input.realNow.getTime()
    const validRules = rules.filter(rule => {
        if (!isActiveAt(rule, nowMs)) return false
        return validateScheduledResourceRuleInput(rule, {
            itemMaxCount: input.itemMaxCount,
            maxFreeVmoney: input.maxFreeVmoney,
            playerExists: playerId => playerId === input.player.id,
        }).ok
    })
    if (validRules.length === 0) return { status: "none", grantedRuleIds: [] }

    const businessDay = getBusinessDayKey(input.realNow, input.dailyResetHour)
    const states = getScheduledResourceStatesByRuleIdsSync(
        input.player.id,
        validRules.map(rule => rule.id),
    )
    const pendingRules = validRules.filter(
        rule => states[rule.id]?.lastGrantedBusinessDay !== businessDay,
    )
    if (pendingRules.length === 0) return { status: "none", grantedRuleIds: [] }

    const itemIds = pendingRules.flatMap(rule => (
        rule.rewardType === "item" && rule.rewardId !== null ? [rule.rewardId] : []
    ))
    const itemAmounts = getPlayerItemsByIdsSync(input.player.id, itemIds)
    const grantedRules = pendingRules.filter(rule => {
        const currentAmount = rule.rewardType === "free_vmoney"
            ? input.player.freeVmoney
            : itemAmounts[String(rule.rewardId)] ?? 0
        return currentAmount < rule.triggerThreshold
    })
    if (grantedRules.length === 0) return { status: "none", grantedRuleIds: [] }

    const plan = createRewardGrantExecutionPlan(grantedRules.map(rule => (
        rule.rewardType === "free_vmoney"
            ? { type: RewardType.BEADS, count: rule.grantAmount }
            : { type: RewardType.ITEM, id: rule.rewardId as number, count: rule.grantAmount }
    )))
    return getDb().transaction(() => {
        const currentPlayer = getPlayerSync(input.player.id)
        if (currentPlayer === null) {
            throw new Error("No player data during scheduled resource settlement.")
        }
        const rewardResult = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            input.player.id,
            plan,
            {
                playerId: input.player.id,
                freeMana: currentPlayer.freeMana,
                freeVmoney: currentPlayer.freeVmoney,
                expPool: currentPlayer.expPool,
            },
            { itemOverflow: createRewardGrantItemOverflowPolicy(input.player.id) },
        )
        const grantedRuleIds = grantedRules.map(rule => rule.id)
        recordScheduledResourceGrantsWithinTransactionSync(
            input.player.id,
            grantedRuleIds,
            businessDay,
            input.realNow,
        )
        return { status: "granted", grantedRuleIds, rewardResult } as const
    })()
}
