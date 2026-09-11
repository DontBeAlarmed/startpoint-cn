import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import {
    validateQuestEntryCostTable,
    validateQuestPrerequisiteTable,
    validateQuestUnlockCostTable,
} from "../content/validation/quest-derived-output"

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

interface QuestEntryContentCatalog {
    readonly entries: Readonly<EntryCostTable>
    readonly unlocks: Readonly<UnlockCostTable>
    readonly prerequisites: Readonly<Record<string, readonly QuestPrerequisite[]>>
}

export interface QuestPrerequisite {
    readonly category: number
    readonly questId: number
}

const catalogs = new WeakMap<ReadonlyContentRepository, QuestEntryContentCatalog>()

export function getQuestEntryContentCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): QuestEntryContentCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = Object.freeze({
        entries: validateQuestEntryCostTable(repository.table("quest_entry_costs.json")),
        unlocks: validateQuestUnlockCostTable(repository.table("quest_unlock_costs.json")),
        prerequisites: validateQuestPrerequisiteTable(repository.table("quest_prerequisites.json")),
    }) as QuestEntryContentCatalog
    catalogs.set(repository, catalog)
    return catalog
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
    return getQuestEntryContentCatalog().entries[`${category}_${questId}`]
}

export function getQuestEntryCostByKey(
    questKey: string,
): QuestEntryCost | undefined {
    return getQuestEntryContentCatalog().entries[questKey]
}

/**
 * Stage-node prerequisites for a main/ex quest; undefined means the quest's
 * node has no need-node (always reachable). Each prerequisite retains its
 * own category for cross-table EX -> Main dependencies.
 */
export function getQuestPrerequisites(
    category: number,
    questId: number,
): readonly QuestPrerequisite[] | undefined {
    return getQuestEntryContentCatalog().prerequisites[`${category}_${questId}`]
}

export function getQuestUnlockCost(
    questId: number,
): QuestUnlockCost | undefined {
    return getQuestEntryContentCatalog().unlocks[String(questId)]
}
