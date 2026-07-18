import { getDb } from "../../data/db"
import {
    deletePlayerActiveQuestSync,
    getPlayerActiveQuestSync,
    insertPlayerActiveQuestSync,
} from "../../data/domains/quest_active"
import { getPlayerItemSync, setPlayerItemSync } from "../../data/domains/item"
import questEntryCosts from "../../../assets/quest_entry_costs.json"
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
        entryItemId: quest.entryItemId ?? null,
        entryItemCount: quest.entryItemCount ?? null,
        eventId: quest.eventId ?? null,
        continueCount: quest.continueCount,
    })
}

export function publishActiveQuest(playerId: number, quest: ActiveQuest): void {
    activeQuests[playerId] = quest
}

export function insertActiveQuest(playerId: number, quest: ActiveQuest): void {
    persistActiveQuest(playerId, quest)
    publishActiveQuest(playerId, quest)
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
        clearActiveQuest: id => { delete activeQuests[id] },
        getEntryCost: (category, questId) => (
            questEntryCosts as Record<string, StartEntryCost>
        )[`${category}_${questId}`],
    })
}
