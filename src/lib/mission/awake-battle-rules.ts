import { getRaceKeyString } from "../quest/finish/race-utils"

export interface PartyCoClearRow {
    char_id_a: number
    char_id_b: number
    co_clear_count: number
}

interface QuestPartyRule {
    missionId: number
    category: number
    questIds: readonly number[]
    requiredCharacterIds: readonly number[]
    singleOnly: boolean
}

interface QuestPartyFactContext {
    questCategory: number
    questId: number
    isMulti?: boolean
    party: {
        characters: readonly ({ id?: number | null } | null)[]
        unison_characters: readonly ({ id?: number | null } | null)[]
    }
}

const QUEST_PARTY_RULES: readonly QuestPartyRule[] = Object.freeze([
    {
        missionId: 3310032,
        category: 15,
        questIds: [5],
        requiredCharacterIds: [331003, 1],
        singleOnly: true,
    },
    {
        missionId: 3310033,
        category: 2,
        questIds: [1010004],
        requiredCharacterIds: [331003, 10],
        singleOnly: true,
    },
])

export const AWAKE_QUEST_PARTY_MISSION_IDS = new Set(
    QUEST_PARTY_RULES.map(rule => rule.missionId),
)

export const AWAKE_RACE_MISSION_KEYS = new Map<number, string>([
    [2310012, getRaceKeyString(["Human", "Dragon", "Devil"])],
])

export const AWAKE_DIRECT_BATTLE_MISSION_IDS = new Set([
    ...AWAKE_QUEST_PARTY_MISSION_IDS,
    ...AWAKE_RACE_MISSION_KEYS.keys(),
])

export function normalizeCharacterPair(a: number, b: number): readonly [number, number] {
    return a <= b ? [a, b] : [b, a]
}

export function getCharacterPairKey(a: number, b: number): string {
    const [first, second] = normalizeCharacterPair(a, b)
    return `${first}_${second}`
}

export function mergePartyCoClearRows(rows: readonly PartyCoClearRow[]): Map<string, number> {
    const result = new Map<string, number>()
    for (const row of rows) {
        const key = getCharacterPairKey(row.char_id_a, row.char_id_b)
        result.set(key, (result.get(key) ?? 0) + row.co_clear_count)
    }
    return result
}

export function getMatchedAwakeQuestPartyMissionIds(
    ctx: QuestPartyFactContext,
): number[] {
    const partyCharacterIds = new Set<number>()
    for (const character of [...ctx.party.characters, ...ctx.party.unison_characters]) {
        if (character?.id) partyCharacterIds.add(character.id)
    }

    return QUEST_PARTY_RULES
        .filter(rule => rule.category === ctx.questCategory)
        .filter(rule => rule.questIds.includes(ctx.questId))
        .filter(rule => !rule.singleOnly || !ctx.isMulti)
        .filter(rule => rule.requiredCharacterIds.every(id => partyCharacterIds.has(id)))
        .map(rule => rule.missionId)
}

export function getMatchedAwakeRaceMissionIds(
    ctx: QuestPartyFactContext,
    raceKey: string,
): number[] {
    const leaderId = ctx.party.characters[0]?.id
    if (leaderId !== 231001) return []
    return AWAKE_RACE_MISSION_KEYS.get(2310012) === raceKey ? [2310012] : []
}

export function isBondTokenMissionComplete(
    bondTokens: readonly { status: number }[] | undefined,
): boolean {
    return bondTokens !== undefined
        && bondTokens.length > 0
        && bondTokens.every(bondToken => bondToken.status >= 2)
}
