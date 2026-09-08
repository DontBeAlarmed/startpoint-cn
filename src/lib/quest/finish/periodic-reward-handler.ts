import { consumePeriodicRewardPointSync } from "../../../data/domains/campaign"
import { getPlayerPeriodicRewardPointsSync } from "../../../data/domains/campaign"
import { getDb } from "../../../data/db"
import { withInventoryBatchContextWithinTransactionSync } from "../../inventory"
import { QuestCategory } from "../../types"
import { createRewardGrantItemOverflowPolicy } from "../../reward-grant-item-overflow"
import {
    settleDirectItemOverflowsWithinTransactionSync,
    type PlannedItemOverflowDisposition,
} from "../../item-overflow"
import {
    getHardMultiQuestPeriodicDefinition,
    getPeriodicRewardGroup,
    resolveActivityPeriodicRewardPointId,
    type PeriodicRewardDefinition,
} from "../periodic-reward-content"

export interface PeriodicRewardDrop {
    readonly group_id: number
    readonly index: number
    readonly number: number
}

export interface ActivityPeriodicRewardSettlement {
    readonly dropPeriodicRewardIds: readonly PeriodicRewardDrop[]
    readonly periodicRewardPointList: readonly { readonly id: number; readonly point: number }[]
    readonly items: Readonly<Record<string, number>>
    readonly itemOverflowDispositions?: readonly PlannedItemOverflowDisposition[]
    readonly overflowFreeManaAfter?: number
}

export interface ActivityPeriodicRewardSettlementInput {
    readonly playerId: number
    readonly questCategory: number
    readonly questId: number
    readonly questAccomplished: boolean
    readonly isMulti: boolean
    readonly random?: () => number
}

function emptySettlement(): ActivityPeriodicRewardSettlement {
    return {
        dropPeriodicRewardIds: [],
        periodicRewardPointList: [],
        items: {},
    }
}

function resolvePointId(eventId: number, groupId: number): number | null {
    return resolveActivityPeriodicRewardPointId(eventId, groupId)
}

function selectReward(
    rewards: Readonly<Record<string, PeriodicRewardDefinition>>,
    random: () => number,
): readonly [index: number, reward: PeriodicRewardDefinition] | null {
    const candidates: Array<{
        index: number
        reward: PeriodicRewardDefinition
        cumulativeProbability: number
    }> = []
    let totalProbability = 0
    for (const [indexText, reward] of Object.entries(rewards)
        .sort(([left], [right]) => Number(left) - Number(right))) {
        if (random() >= reward.probability) continue
        totalProbability += reward.probability
        candidates.push({ index: Number(indexText), reward, cumulativeProbability: totalProbability })
    }
    if (candidates.length === 0) return null
    const selected = random() * totalProbability
    const candidate = candidates.find(entry => selected <= entry.cumulativeProbability)
        ?? candidates[candidates.length - 1]
    return [candidate.index, candidate.reward]
}

export function settleActivityPeriodicRewardsSync(
    input: ActivityPeriodicRewardSettlementInput,
): ActivityPeriodicRewardSettlement {
    if (!getDb().inTransaction) {
        throw new Error("settleActivityPeriodicRewardsSync requires an active caller transaction")
    }
    if (!input.questAccomplished
        || !input.isMulti
        || input.questCategory !== QuestCategory.HARD_MULTI_EVENT) {
        return emptySettlement()
    }

    const quest = getHardMultiQuestPeriodicDefinition(input.questId)
    const groupId = quest?.periodicRewardGroupId
    if (quest === undefined || groupId === undefined || (quest.periodicRewardSlots ?? 0) <= 0) return emptySettlement()

    const eventId = Math.floor(input.questId / 1000)
    const pointId = resolvePointId(eventId, groupId)
    if (pointId === null) return emptySettlement()
    const availablePoint = getPlayerPeriodicRewardPointsSync(input.playerId)
        .find(entry => entry.id === pointId)?.point ?? 0
    if (availablePoint <= 0) return emptySettlement()

    const rewards = getPeriodicRewardGroup(groupId)
    if (rewards === undefined) throw new Error(`Missing periodic reward group ${groupId}`)
    const selected = selectReward(rewards, input.random ?? Math.random)
    if (selected === null) return emptySettlement()

    const [index, reward] = selected
    if (reward.kind !== 0) throw new Error(`Unsupported periodic reward kind ${reward.kind}`)
    const remainingPoint = consumePeriodicRewardPointSync(input.playerId, pointId)
    if (remainingPoint === null) return emptySettlement()
    return withInventoryBatchContextWithinTransactionSync({
        playerId: input.playerId,
        playerExistence: "caller-verified",
    }, inventory => {
        const overflowPolicy = createRewardGrantItemOverflowPolicy(input.playerId)
        const item = inventory.grantWithCapacity(
            reward.itemId,
            reward.count,
            overflowPolicy.maxCount(reward.itemId),
        )
        inventory.flush()
        const overflowSettlement = item.overflowAmount > 0
            ? settleDirectItemOverflowsWithinTransactionSync({
                playerId: input.playerId,
                overflows: [{ itemId: reward.itemId, amount: item.overflowAmount }],
            })
            : null
        return {
            dropPeriodicRewardIds: [{ group_id: groupId, index, number: reward.count }],
            periodicRewardPointList: [{ id: pointId, point: remainingPoint }],
            items: { [reward.itemId]: item.afterAmount },
            ...(overflowSettlement === null
                ? {}
                : { itemOverflowDispositions: overflowSettlement.dispositions }),
            ...(overflowSettlement === null
                ? {}
                : { overflowFreeManaAfter: overflowSettlement.freeManaAfter }),
        }
    })
}
