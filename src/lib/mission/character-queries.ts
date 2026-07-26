// Character → quest mapping helpers

import charQuests from "../../../assets/character_quest_lookup.json"

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

const bundledCharacterStoryQuestIndex = buildCharacterStoryQuestIndex(
    charQuests as RawCharacterQuestTable,
)

export function getCharacterIdFromMission(missionId: number): string {
    const s = String(missionId)
    return s.length > 1 ? s.substring(0, s.length - 1) : s
}

export function getCharacterStoryQuestIds(characterId: number | string): number[] {
    return [...(bundledCharacterStoryQuestIndex?.get(String(characterId)) ?? [])]
}
