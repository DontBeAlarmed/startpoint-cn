// Character → quest mapping helpers

import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"

type RawCharacterQuestTable = Record<string, unknown>

export function buildCharacterStoryQuestIndex(
    table: RawCharacterQuestTable,
): ReadonlyMap<string, readonly number[]> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const index = new Map<string, number[]>()
    for (const [questIdText, rawRows] of Object.entries(table)) {
        const questId = Number(questIdText)
        if (!Number.isSafeInteger(questId) || questId <= 0
            || !Array.isArray(rawRows) || rawRows.length !== 1
            || !Array.isArray(rawRows[0])) return null
        const row = rawRows[0]
        const characterIds: number[] = []
        for (let field = 0; field <= 2; field++) {
            const rawCharacterId = row[field]
            if (field > 0 && rawCharacterId === "(None)") continue
            const characterId = Number(rawCharacterId)
            if (!Number.isSafeInteger(characterId) || characterId <= 0) return null
            characterIds.push(characterId)
        }
        for (const characterId of new Set(characterIds)) {
            const key = String(characterId)
            const questIds = index.get(key) ?? []
            questIds.push(questId)
            index.set(key, questIds)
        }
    }
    return index
}

const characterStoryQuestIndexByTable = new WeakMap<
    RawCharacterQuestTable,
    ReadonlyMap<string, readonly number[]> | null
>()

function getCharacterQuestTable(
    repository?: ReadonlyContentRepository,
): RawCharacterQuestTable {
    const resolved = repository ?? getContentSnapshot().repository
    return resolved.table<RawCharacterQuestTable>("character_quest_lookup.json")
}

function getCharacterStoryQuestIndex(
    repository?: ReadonlyContentRepository,
): ReadonlyMap<string, readonly number[]> | null {
    const table = getCharacterQuestTable(repository)
    if (characterStoryQuestIndexByTable.has(table)) {
        return characterStoryQuestIndexByTable.get(table) ?? null
    }
    const index = buildCharacterStoryQuestIndex(table)
    characterStoryQuestIndexByTable.set(table, index)
    return index
}

export function getCharacterIdFromMission(missionId: number): string {
    const s = String(missionId)
    return s.length > 1 ? s.substring(0, s.length - 1) : s
}

export function getCharacterStoryQuestIds(
    characterId: number | string,
    repository?: ReadonlyContentRepository,
): number[] {
    return [...(getCharacterStoryQuestIndex(repository)?.get(String(characterId)) ?? [])]
}
