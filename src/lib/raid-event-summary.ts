import type { PlayerRewardResult } from "./types"
import {
    RaidOverallRewardDefinition,
    RaidOverallRewardGrant,
    selectRaidEventOverallRewards,
    toPlayerReward,
} from "./quest/finish/raid-overall-rewards"

function aggregateGrantsForInventory(grants: readonly RaidOverallRewardGrant[]) {
    const aggregate = new Map<string, RaidOverallRewardGrant>()
    for (const grant of grants) {
        const key = `${grant.kind}:${grant.itemId ?? ""}`
        const current = aggregate.get(key)
        aggregate.set(key, current
            ? { ...current, amount: current.amount + grant.amount }
            : { ...grant })
    }
    return [...aggregate.values()].map(toPlayerReward)
}

export function settleRaidEventSummary(params: {
    playerId: number
    totalKillCount: number
    receivedUpTo: number
    definitions: readonly RaidOverallRewardDefinition[]
    giveRewards: (playerId: number, rewards: ReturnType<typeof toPlayerReward>[]) => PlayerRewardResult | null
    updateReceivedUpTo: (receivedUpTo: number) => void
}): {
    grants: readonly RaidOverallRewardGrant[]
    rewardResult?: PlayerRewardResult
} {
    const { playerId, totalKillCount, receivedUpTo, definitions, giveRewards, updateReceivedUpTo } = params
    if (!Number.isSafeInteger(totalKillCount) || totalKillCount < 0
        || !Number.isSafeInteger(receivedUpTo) || receivedUpTo < 0) {
        throw new Error("invalid raid event reward cursor")
    }
    if (totalKillCount <= receivedUpTo) return { grants: [] }

    const grants = selectRaidEventOverallRewards(definitions, receivedUpTo, totalKillCount)
    const inventoryRewards = aggregateGrantsForInventory(grants)
    const rewardResult = inventoryRewards.length > 0
        ? giveRewards(playerId, inventoryRewards) ?? undefined
        : undefined
    updateReceivedUpTo(totalKillCount)
    return { grants, ...(rewardResult ? { rewardResult } : {}) }
}
