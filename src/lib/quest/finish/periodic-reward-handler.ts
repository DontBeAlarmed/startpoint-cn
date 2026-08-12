import bundledHardMultiEvents from "../../../../assets/hard_multi_event.json"
import bundledHardMultiQuests from "../../../../assets/hard_multi_event_quest.json"
import bundledPeriodicRewards from "../../../../assets/periodic_reward.json"
import { getRuntimeContentTableSync } from "../../../content/runtime/table-access"
import { consumePeriodicRewardPointSync } from "../../../data/domains/campaign"
import { getPlayerPeriodicRewardPointsSync } from "../../../data/domains/campaign"
import { givePlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { getDb } from "../../../data/db"
import { QuestCategory } from "../../types"

interface HardMultiEventDefinition {
    periodicPointId?: number
}

interface HardMultiQuestDefinition {
    periodicRewardGroupId?: number
    periodicRewardSlots?: number
}

interface PeriodicRewardDefinition {
    kind: number
    itemId: number
    count: number
    probability: number
}

export interface PeriodicRewardDrop {
    readonly group_id: number
    readonly index: number
    readonly number: number
}

export interface ActivityPeriodicRewardSettlement {
    readonly dropPeriodicRewardIds: readonly PeriodicRewardDrop[]
    readonly periodicRewardPointList: readonly { readonly id: number; readonly point: number }[]
    readonly items: Readonly<Record<string, number>>
}

export interface ActivityPeriodicRewardSettlementInput {
    readonly playerId: number
    readonly questCategory: number
    readonly questId: number
    readonly questAccomplished: boolean
    readonly isMulti: boolean
    readonly random?: () => number
}

const FINAL_OPERATION_EVENT_IDS = new Set([1001, 1002, 1003, 1004, 1005, 1006])

function emptySettlement(): ActivityPeriodicRewardSettlement {
    return { dropPeriodicRewardIds: [], periodicRewardPointList: [], items: {} }
}

function resolvePointId(eventId: number, groupId: number): number | null {
    const events = getRuntimeContentTableSync(
        "hard_multi_event.json",
        bundledHardMultiEvents as Record<string, HardMultiEventDefinition>,
    )
    const configured = events[String(eventId)]?.periodicPointId
    if (configured !== undefined) return configured
    return FINAL_OPERATION_EVENT_IDS.has(eventId) ? groupId : null
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

    const quests = getRuntimeContentTableSync(
        "hard_multi_event_quest.json",
        bundledHardMultiQuests as Record<string, HardMultiQuestDefinition>,
    )
    const quest = quests[String(input.questId)]
    const groupId = quest?.periodicRewardGroupId
    if (groupId === undefined || (quest.periodicRewardSlots ?? 0) <= 0) return emptySettlement()

    const eventId = Math.floor(input.questId / 1000)
    const pointId = resolvePointId(eventId, groupId)
    if (pointId === null) return emptySettlement()
    const availablePoint = getPlayerPeriodicRewardPointsSync(input.playerId)
        .find(entry => entry.id === pointId)?.point ?? 0
    if (availablePoint <= 0) return emptySettlement()

    const rewardsByGroup = getRuntimeContentTableSync(
        "periodic_reward.json",
        bundledPeriodicRewards as Record<string, Record<string, PeriodicRewardDefinition>>,
    )
    const selected = selectReward(rewardsByGroup[String(groupId)] ?? {}, input.random ?? Math.random)
    if (selected === null) return emptySettlement()

    const [index, reward] = selected
    if (reward.kind !== 0) return emptySettlement()
    const remainingPoint = consumePeriodicRewardPointSync(input.playerId, pointId)
    if (remainingPoint === null) return emptySettlement()
    const amount = givePlayerItemWithinTransactionSync(
        input.playerId,
        reward.itemId,
        reward.count,
    )
    return {
        dropPeriodicRewardIds: [{ group_id: groupId, index, number: reward.count }],
        periodicRewardPointList: [{ id: pointId, point: remainingPoint }],
        items: { [reward.itemId]: amount },
    }
}
