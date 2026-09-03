import type { PlayerRewardResult } from "./types"
import type { FactKey } from "./mission/facts/fact-key"
import type { RaidEventRewardGrantResult } from "./raid-event-reward-grant"
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
    giveRewards: (playerId: number, rewards: ReturnType<typeof toPlayerReward>[]) => RaidEventRewardGrantResult
    updateReceivedUpTo: (receivedUpTo: number) => void
}): {
    grants: readonly RaidOverallRewardGrant[]
    rewardResult?: PlayerRewardResult
    invalidatedFactKeys: readonly FactKey[]
} {
    const { playerId, totalKillCount, receivedUpTo, definitions, giveRewards, updateReceivedUpTo } = params
    if (!Number.isSafeInteger(totalKillCount) || totalKillCount < 0
        || !Number.isSafeInteger(receivedUpTo) || receivedUpTo < 0) {
        throw new Error("invalid raid event reward cursor")
    }
    if (totalKillCount <= receivedUpTo) return { grants: [], invalidatedFactKeys: [] }

    const grants = selectRaidEventOverallRewards(definitions, receivedUpTo, totalKillCount)
    const inventoryRewards = aggregateGrantsForInventory(grants)
    const rewardGrant = inventoryRewards.length > 0
        ? giveRewards(playerId, inventoryRewards)
        : undefined
    updateReceivedUpTo(totalKillCount)
    return {
        grants,
        invalidatedFactKeys: rewardGrant?.invalidatedFactKeys ?? [],
        ...(rewardGrant ? { rewardResult: rewardGrant.rewardResult } : {}),
    }
}
