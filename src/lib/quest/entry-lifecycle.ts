import type { StartEntryCost } from "./start-entry"

export interface EntryLifecycleActiveQuest {
    playId: string
    questId: number
    category: number
    entryItemId?: number | null
    entryItemCount?: number | null
}

export interface AbortEntryInput {
    playerId: number
    playId: string | null
    questId: number | null
    category: number | null
}

export interface AbortEntryDependencies<TActiveQuest extends EntryLifecycleActiveQuest> {
    transaction<T>(operation: () => T): T
    getActiveQuest(playerId: number): TActiveQuest | null
    getItemCount(playerId: number, itemId: number): number | null
    setItemCount(playerId: number, itemId: number, amount: number): void
    deleteActiveQuest(playerId: number): void
    clearActiveQuest(playerId: number): void
    getEntryCost(category: number, questId: number): StartEntryCost | undefined
}

export interface RestoreActiveQuestDependencies<TActiveQuest extends EntryLifecycleActiveQuest> {
    getEntryCost(category: number, questId: number): StartEntryCost | undefined
    persistEntryItemCount?(playerId: number, itemCount: number): void
    publishActiveQuest(playerId: number, activeQuest: TActiveQuest): void
}

export interface AbortEntryResult<TActiveQuest> {
    cancelled: boolean
    activeQuest: TActiveQuest | null
    observedActiveQuest: TActiveQuest | null
    resolvedIdentity: {
        playId: string
        questId: number
        category: number
    }
    itemList: Record<string, number>
}

interface PrepaidEntryItem {
    itemId: number
    itemCount: number
}

function resolvePrepaidEntryItem(
    activeQuest: EntryLifecycleActiveQuest,
    getEntryCost: (category: number, questId: number) => StartEntryCost | undefined,
): PrepaidEntryItem | null {
    const itemId = activeQuest.entryItemId
    if (itemId === null || itemId === undefined || itemId <= 0) return null

    const storedCount = activeQuest.entryItemCount
    if (storedCount !== null && storedCount !== undefined) {
        return storedCount > 0 ? { itemId, itemCount: storedCount } : null
    }

    const currentCost = getEntryCost(activeQuest.category, activeQuest.questId)
    if (!currentCost || currentCost.itemId !== itemId || currentCost.itemCount !== 1) return null
    return { itemId, itemCount: currentCost.itemCount }
}

export function runAbortEntryTransaction<TActiveQuest extends EntryLifecycleActiveQuest>(
    input: AbortEntryInput,
    dependencies: AbortEntryDependencies<TActiveQuest>,
): AbortEntryResult<TActiveQuest> {
    const result = dependencies.transaction(() => {
        const activeQuest = dependencies.getActiveQuest(input.playerId)
        const resolvedIdentity = {
            playId: input.playId ?? activeQuest?.playId ?? "",
            questId: input.questId ?? activeQuest?.questId ?? 0,
            category: input.category ?? activeQuest?.category ?? 0,
        }
        const matchesActiveQuest = activeQuest
            && activeQuest.playId === resolvedIdentity.playId
            && activeQuest.questId === resolvedIdentity.questId
            && activeQuest.category === resolvedIdentity.category
        if (!activeQuest || !matchesActiveQuest) {
            return {
                cancelled: false,
                activeQuest: null,
                observedActiveQuest: activeQuest,
                resolvedIdentity,
                itemList: {},
            }
        }

        const prepaidItem = resolvePrepaidEntryItem(activeQuest, dependencies.getEntryCost)
        const itemList: Record<string, number> = {}
        if (prepaidItem) {
            const afterCount = (dependencies.getItemCount(input.playerId, prepaidItem.itemId) ?? 0)
                + prepaidItem.itemCount
            dependencies.setItemCount(input.playerId, prepaidItem.itemId, afterCount)
            itemList[prepaidItem.itemId] = afterCount
        }

        dependencies.deleteActiveQuest(input.playerId)
        return {
            cancelled: true,
            activeQuest,
            observedActiveQuest: activeQuest,
            resolvedIdentity,
            itemList,
        }
    })

    if (result.cancelled || result.observedActiveQuest === null) {
        dependencies.clearActiveQuest(input.playerId)
    }
    return result
}

export function restoreActiveQuestFromStorage<TActiveQuest extends EntryLifecycleActiveQuest>(
    playerId: number,
    activeQuest: TActiveQuest,
    dependencies: RestoreActiveQuestDependencies<TActiveQuest>,
): TActiveQuest {
    const prepaidItem = resolvePrepaidEntryItem(activeQuest, dependencies.getEntryCost)
    const restoredQuest = prepaidItem && activeQuest.entryItemCount !== prepaidItem.itemCount
        ? { ...activeQuest, entryItemCount: prepaidItem.itemCount }
        : activeQuest
    if (prepaidItem && activeQuest.entryItemCount !== prepaidItem.itemCount) {
        dependencies.persistEntryItemCount?.(playerId, prepaidItem.itemCount)
    }
    dependencies.publishActiveQuest(playerId, restoredQuest)
    return restoredQuest
}
