import { getContentSnapshot } from "../content/runtime/content-snapshot"

export interface QuestEntryCost {
    readonly itemId: number
    readonly itemCount: number
    readonly stamina: number
}

export interface QuestUnlockCost {
    readonly itemIds: readonly number[]
    readonly itemCounts: readonly number[]
}

type EntryCostTable = Record<string, QuestEntryCost>
type UnlockCostTable = Record<string, QuestUnlockCost>

function getEntryCostTable(): EntryCostTable {
    return getContentSnapshot().repository.table<EntryCostTable>("quest_entry_costs.json")
}

function getUnlockCostTable(): UnlockCostTable {
    return getContentSnapshot().repository.table<UnlockCostTable>("quest_unlock_costs.json")
}

/**
 * Limited quest entry/unlock cost queries. Stamina and item entry costs live
 * in quest_entry_costs.json keyed by `${category}_${questId}`; once-unlock
 * item costs live in quest_unlock_costs.json keyed by quest id.
 */
export function getQuestEntryCost(
    category: number,
    questId: number,
): QuestEntryCost | undefined {
    return getEntryCostTable()[`${category}_${questId}`]
}

export function getQuestEntryCostByKey(
    questKey: string,
): QuestEntryCost | undefined {
    return getEntryCostTable()[questKey]
}

export function getQuestUnlockCost(
    questId: number,
): QuestUnlockCost | undefined {
    return getUnlockCostTable()[String(questId)]
}
