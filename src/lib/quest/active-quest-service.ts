import { getDb } from "../../data/db"
import {
    deletePlayerActiveQuestSync,
    getPlayerActiveQuestSync,
    insertPlayerActiveQuestSync,
    updatePlayerActiveQuestContinueCountSync,
} from "../../data/domains/quest_active"
import { getPlayerItemSync, setPlayerItemSync } from "../../data/domains/item"
import bundledQuestEntryCosts from "../../../assets/quest_entry_costs.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import { runAbortEntryTransaction } from "./entry-lifecycle"
import type { StartEntryCost } from "./start-entry"

export interface ActiveQuest {
    questId: number
    category: number
    useBossBoostPoint: boolean
    useBoostPoint: boolean
    isAutoStartMode: boolean
    isMulti: boolean
    roomNumber?: string | null
    battleSessionId?: string | null
    matePlayerIds?: number[]
    mateComIds?: number[]
    entryItemId?: number | null
    entryItemCount?: number | null
    eventId?: number | null
    playId: string
    continueCount: number
}

export interface ActiveQuestIdentity {
    playId: string
    questId: number
    category: number
}

export const activeQuests: Record<number, ActiveQuest> = {}

export function persistActiveQuest(playerId: number, quest: ActiveQuest): void {
    insertPlayerActiveQuestSync(playerId, {
        playerId,
        playId: quest.playId,
        questId: quest.questId,
        category: quest.category,
        useBossBoostPoint: quest.useBossBoostPoint,
        useBoostPoint: quest.useBoostPoint,
        isAutoStartMode: quest.isAutoStartMode,
        isMulti: quest.isMulti,
        roomNumber: quest.roomNumber ?? null,
        battleSessionId: quest.battleSessionId ?? null,
        entryItemId: quest.entryItemId ?? null,
        entryItemCount: quest.entryItemCount ?? null,
        eventId: quest.eventId ?? null,
        continueCount: quest.continueCount,
    })
}

export function publishActiveQuest(playerId: number, quest: ActiveQuest): void {
    activeQuests[playerId] = quest
}

export function clearPublishedActiveQuest(playerId: number): void {
    delete activeQuests[playerId]
}

export function insertActiveQuest(playerId: number, quest: ActiveQuest): void {
    persistActiveQuest(playerId, quest)
    publishActiveQuest(playerId, quest)
}

export interface ContinueActiveQuestDependencies {
    transaction<T>(operation: () => T): T
    getStoredActiveQuest(playerId: number): ActiveQuest | null
    updateStoredContinueCount(playerId: number, continueCount: number): void
}

const continueActiveQuestDependencies: ContinueActiveQuestDependencies = {
    transaction: operation => getDb().transaction(operation)(),
    getStoredActiveQuest: getPlayerActiveQuestSync,
    updateStoredContinueCount: updatePlayerActiveQuestContinueCountSync,
}

function matchesActiveQuestIdentity(
    quest: Pick<ActiveQuest, "playId" | "questId" | "category" | "isMulti">,
    identity: ActiveQuestIdentity,
): boolean {
    return quest.isMulti
        && quest.playId === identity.playId
        && quest.questId === identity.questId
        && quest.category === identity.category
}

export function runContinueActiveQuestTransaction(
    playerId: number,
    memoryQuest: ActiveQuest,
    identity: ActiveQuestIdentity,
    dependencies: ContinueActiveQuestDependencies = continueActiveQuestDependencies,
): number | null {
    if (!matchesActiveQuestIdentity(memoryQuest, identity)) return null

    const continueCount = dependencies.transaction(() => {
        const storedQuest = dependencies.getStoredActiveQuest(playerId)
        if (!storedQuest || !matchesActiveQuestIdentity(storedQuest, identity)) return null
        const nextCount = storedQuest.continueCount + 1
        dependencies.updateStoredContinueCount(playerId, nextCount)
        return nextCount
    })
    if (continueCount === null) return null
    memoryQuest.continueCount = continueCount
    return continueCount
}

export function runAbortActiveQuestTransaction(
    playerId: number,
    identity: ActiveQuestIdentity,
) {
    return runAbortEntryTransaction({ playerId, ...identity }, {
        transaction: operation => getDb().transaction(operation)(),
        getActiveQuest: getPlayerActiveQuestSync,
        getItemCount: getPlayerItemSync,
        setItemCount: setPlayerItemSync,
        deleteActiveQuest: deletePlayerActiveQuestSync,
        clearActiveQuest: clearPublishedActiveQuest,
        getEntryCost: (category, questId) => (
            getRuntimeContentTableSync(
                "quest_entry_costs.json",
                bundledQuestEntryCosts as Record<string, StartEntryCost>,
            )
        )[`${category}_${questId}`],
    })
}
