import { getRaceKeyString } from "../quest/finish/race-utils"

export interface PartyCoClearRow {
    char_id_a: number
    char_id_b: number
    co_clear_count: number
}

interface QuestPartyRule {
    missionId: number
    category?: number
    questIds?: readonly number[]
    requiredCharacterIds: readonly number[]
    singleOnly: boolean
    leaderCharacterId?: number
}

interface QuestPartyFactContext {
    questCategory: number
    questId: number
    isMulti?: boolean
    party: {
        characters: readonly ({ id?: number | null } | null)[]
        unison_characters: readonly ({ id?: number | null } | null)[]
    }
    statistics?: {
        zones?: readonly { encoffin_count?: unknown }[]
    }
}

interface QuestRangeRule {
    missionId: number
    categories: readonly number[]
    questIds?: readonly number[]
    requiredCharacterId: number
    singleOnly: boolean
}

interface NoDeathRule {
    missionId: number
    leaderCharacterId: number
}

const QUEST_PARTY_RULES: readonly QuestPartyRule[] = Object.freeze([
    {
        missionId: 1510062,
        requiredCharacterIds: [151006, 263002],
        singleOnly: false,
        leaderCharacterId: 151006,
    },
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

const QUEST_RANGE_RULES: readonly QuestRangeRule[] = Object.freeze([
    {
        missionId: 3210132,
        categories: [6, 13, 14, 20],
        requiredCharacterId: 321013,
        singleOnly: true,
    },
    {
        missionId: 3210133,
        categories: [13],
        questIds: [2001, 2002, 2003, 2004, 2005, 2006],
        requiredCharacterId: 321013,
        singleOnly: true,
    },
    {
        missionId: 3410012,
        categories: [6, 13, 14, 20],
        requiredCharacterId: 341001,
        singleOnly: true,
    },
    {
        missionId: 3410013,
        categories: [13],
        questIds: [1040],
        requiredCharacterId: 341001,
        singleOnly: true,
    },
])

const NO_DEATH_RULES: readonly NoDeathRule[] = Object.freeze([
    { missionId: 1610022, leaderCharacterId: 161002 },
    { missionId: 2610072, leaderCharacterId: 261007 },
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
    ...QUEST_RANGE_RULES.map(rule => rule.missionId),
    ...NO_DEATH_RULES.map(rule => rule.missionId),
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
        .filter(rule => rule.category === undefined || rule.category === ctx.questCategory)
        .filter(rule => rule.questIds === undefined || rule.questIds.includes(ctx.questId))
        .filter(rule => !rule.singleOnly || !ctx.isMulti)
        .filter(rule => rule.leaderCharacterId === undefined
            || ctx.party.characters[0]?.id === rule.leaderCharacterId)
        .filter(rule => rule.requiredCharacterIds.every(id => partyCharacterIds.has(id)))
        .map(rule => rule.missionId)
}

export function getMatchedAwakeDirectBattleMissionIds(
    ctx: QuestPartyFactContext,
    raceKey: string,
): number[] {
    const matched = [
        ...getMatchedAwakeRaceMissionIds(ctx, raceKey),
        ...getMatchedAwakeQuestPartyMissionIds(ctx),
    ]
    const partyCharacterIds = new Set<number>()
    for (const character of [...ctx.party.characters, ...ctx.party.unison_characters]) {
        if (character?.id) partyCharacterIds.add(character.id)
    }

    for (const rule of QUEST_RANGE_RULES) {
        if (!rule.categories.includes(ctx.questCategory)) continue
        if (rule.questIds && !rule.questIds.includes(ctx.questId)) continue
        if (rule.singleOnly && ctx.isMulti === true) continue
        if (partyCharacterIds.has(rule.requiredCharacterId)) matched.push(rule.missionId)
    }

    const zones = ctx.statistics?.zones
    if (zones !== undefined && zones.length > 0 && zones.every(zone => (
        Number.isSafeInteger(zone.encoffin_count)
        && (zone.encoffin_count as number) >= 0
    ))) {
        const totalEncoffinCount = zones.reduce(
            (total, zone) => total + (zone.encoffin_count as number),
            0,
        )
        if (totalEncoffinCount === 0) {
            const leaderId = ctx.party.characters[0]?.id
            for (const rule of NO_DEATH_RULES) {
                if (leaderId === rule.leaderCharacterId) matched.push(rule.missionId)
            }
        }
    }

    return matched
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
