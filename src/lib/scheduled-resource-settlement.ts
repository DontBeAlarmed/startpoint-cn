import type { Player } from "../data/types"
import { getDb } from "../data/db"
import { getPlayerItemsByIdsSync } from "../data/domains/item"
import {
    getScheduledResourceStatesByRuleIdsSync,
    listScheduledResourceRulesForPlayerSync,
    recordScheduledResourceGrantsWithinTransactionSync,
    type ScheduledResourceRule,
} from "../data/domains/scheduled-resource"
import { getBusinessDayKey } from "./time-utils"
import { createRewardGrantPlan } from "./reward-grant"
import { executeRewardGrantPlanInTransactionOwnerSync } from "./reward-grant/owner-executor"
import type { RewardGrantResult } from "./reward-grant/types"
import { RewardType } from "./types/rewards"
import { validateScheduledResourceRuleInput } from "./scheduled-resource-rules"

type SettlementPlayer = Pick<Player, "id" | "freeMana" | "freeVmoney" | "expPool">

export interface ScheduledResourceSettlementInput {
    readonly player: SettlementPlayer
    readonly realNow: Date
    readonly dailyResetHour: number
    readonly itemMaxCounts: Readonly<Record<string, number>>
    readonly maxFreeVmoney: number
}

interface ScheduledResourceGrantSource {
    readonly ruleId: number
}

export type ScheduledResourceSettlementResult =
    | {
        readonly status: "none"
        readonly grantedRuleIds: readonly []
    }
    | {
        readonly status: "granted"
        readonly grantedRuleIds: readonly number[]
        readonly rewardResult: RewardGrantResult<ScheduledResourceGrantSource>
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
            itemMaxCounts: input.itemMaxCounts,
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

    const plan = createRewardGrantPlan(grantedRules.map(rule => ({
        source: { ruleId: rule.id },
        reward: rule.rewardType === "free_vmoney"
            ? { type: RewardType.BEADS, count: rule.grantAmount }
            : { type: RewardType.ITEM, id: rule.rewardId as number, count: rule.grantAmount },
    })))
    const knownItemsBefore = Object.fromEntries([...new Set(grantedRules.flatMap(rule => (
        rule.rewardType === "item" && rule.rewardId !== null ? [rule.rewardId] : []
    )))].map(itemId => [String(itemId), itemAmounts[String(itemId)] ?? null]))

    return getDb().transaction(() => {
        const rewardResult = executeRewardGrantPlanInTransactionOwnerSync(
            input.player.id,
            plan,
            {
                freeMana: input.player.freeMana,
                freeVmoney: input.player.freeVmoney,
                expPool: input.player.expPool,
            },
            {},
            knownItemsBefore,
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
