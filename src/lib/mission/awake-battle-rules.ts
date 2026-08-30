import {
    assertAwakeMissionFields,
} from "./awake-rule-catalog"

export {
    getAwakeGenericCharacterClearRules,
    getAwakeMissionRuleFamilies,
    isAwakeGenericCharacterClearMission,
} from "./awake-rule-catalog"

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
        zones?: unknown
        max_combo_count?: unknown
    }
}

interface AwakeBattleFactContext extends QuestPartyFactContext {
    questAccomplished: boolean
    clearTime: number
}

export interface AwakeBattleProgressFacts {
    readonly increments: readonly {
        readonly missionId: number
        readonly delta: number
    }[]
    readonly maxima: readonly {
        readonly missionId: number
        readonly progress: number
    }[]
}

interface QuestRangeRule {
    missionId: number
    categories: readonly number[]
    questIds?: readonly number[]
    requiredCharacterId: number
    singleOnly: boolean
}

interface ExactQuestRule {
    missionId: number
    category: number
    questIds: readonly number[]
    leaderCharacterId: number
    singleOnly: boolean
    timeLimitMs?: number
}

interface NoDeathRule {
    missionId: number
    leaderCharacterId: number
}

const BARAK_AWAKE_PRACTICE_QUEST_ID = 25

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

const EXACT_QUEST_RULES: readonly ExactQuestRule[] = Object.freeze([
    { missionId: 1110013, category: 2, questIds: [1028004], leaderCharacterId: 111001, singleOnly: true },
    { missionId: 1310052, category: 15, questIds: [BARAK_AWAKE_PRACTICE_QUEST_ID], leaderCharacterId: 131005, singleOnly: true },
    { missionId: 2110013, category: 2, questIds: [1028004], leaderCharacterId: 211001, singleOnly: false },
    { missionId: 2310013, category: 2, questIds: [1010004], leaderCharacterId: 231001, singleOnly: true, timeLimitMs: 90000 },
    { missionId: 2510032, category: 13, questIds: [1020, 1023, 1026, 1029, 1032, 1035, 1038], leaderCharacterId: 251003, singleOnly: true },
    { missionId: 2510033, category: 13, questIds: [1020, 1023, 1026, 1029, 1032, 1035, 1038], leaderCharacterId: 251003, singleOnly: true, timeLimitMs: 180000 },
    { missionId: 2630023, category: 18, questIds: [400001104], leaderCharacterId: 151006, singleOnly: true },
])

const THREE_CHARACTER_RULE = Object.freeze({
    missionId: 2410633,
    requiredCharacterIds: Object.freeze([241063, 243007, 361009]),
})

const LEADER_POWERFLIP_RULES = new Map<number, number>([
    [1, 13],
    [121001, 1210012],
])

const LEADER_COMBO_RULES = new Map<number, number>([
    [121001, 1210013],
])

const REQUIRED_RACE_MISSION = Object.freeze({
    missionId: 2310012,
    leaderCharacterId: 231001,
    requiredRaces: Object.freeze(["Human", "Dragon", "Devil"]),
})

const NO_DEATH_RULES: readonly NoDeathRule[] = Object.freeze([
    { missionId: 1610022, leaderCharacterId: 161002 },
    { missionId: 2610072, leaderCharacterId: 261007 },
])

export const AWAKE_QUEST_PARTY_MISSION_IDS = new Set(
    QUEST_PARTY_RULES.map(rule => rule.missionId),
)

export const AWAKE_DIRECT_BATTLE_MISSION_IDS = new Set([
    ...AWAKE_QUEST_PARTY_MISSION_IDS,
    ...QUEST_RANGE_RULES.map(rule => rule.missionId),
    ...EXACT_QUEST_RULES.map(rule => rule.missionId),
    THREE_CHARACTER_RULE.missionId,
    ...LEADER_POWERFLIP_RULES.values(),
    ...LEADER_COMBO_RULES.values(),
    REQUIRED_RACE_MISSION.missionId,
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
    validateAwakeBattleRuleSchemas()
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

    for (const rule of EXACT_QUEST_RULES) {
        if (rule.category !== ctx.questCategory || !rule.questIds.includes(ctx.questId)) continue
        if (rule.singleOnly && ctx.isMulti === true) continue
        if (ctx.party.characters[0]?.id !== rule.leaderCharacterId) continue
        if (rule.timeLimitMs !== undefined) {
            const clearTime = (ctx as Partial<AwakeBattleFactContext>).clearTime
            if (!Number.isFinite(clearTime) || clearTime! < 0 || clearTime! > rule.timeLimitMs) continue
        }
        matched.push(rule.missionId)
    }

    if (THREE_CHARACTER_RULE.requiredCharacterIds.every(id => partyCharacterIds.has(id))) {
        matched.push(THREE_CHARACTER_RULE.missionId)
    }

    if (hasZeroTotalZoneStatistic(ctx.statistics?.zones, "encoffinment_count")) {
        const leaderId = ctx.party.characters[0]?.id
        for (const rule of NO_DEATH_RULES) {
            if (leaderId === rule.leaderCharacterId) matched.push(rule.missionId)
        }
    }

    return matched
}

export function getAwakeBattleProgressFacts(
    ctx: AwakeBattleFactContext,
    raceKey = "",
): AwakeBattleProgressFacts {
    validateAwakeBattleRuleSchemas()
    if (ctx.questAccomplished !== true) return { increments: [], maxima: [] }

    const increments = getMatchedAwakeDirectBattleMissionIds(ctx, raceKey)
        .map(missionId => ({ missionId, delta: 1 }))
    const maxima: { missionId: number; progress: number }[] = []
    const leaderId = ctx.party.characters[0]?.id

    if (leaderId) {
        const powerflipMissionId = LEADER_POWERFLIP_RULES.get(leaderId)
        if (powerflipMissionId !== undefined) {
            const delta = sumNonNegativeZoneStatistic(ctx.statistics?.zones, "use_power_flip_count")
            if (delta !== null && delta > 0) increments.push({ missionId: powerflipMissionId, delta })
        }

        const comboMissionId = LEADER_COMBO_RULES.get(leaderId)
        const combo = ctx.statistics?.max_combo_count
        if (comboMissionId !== undefined && Number.isSafeInteger(combo) && (combo as number) > 0) {
            maxima.push({ missionId: comboMissionId, progress: combo as number })
        }
    }

    increments.sort((left, right) => left.missionId - right.missionId)
    maxima.sort((left, right) => left.missionId - right.missionId)
    return { increments, maxima }
}

function sumNonNegativeZoneStatistic(zones: unknown, key: string): number | null {
    if (!Array.isArray(zones)) return 0
    let total = 0
    for (const zone of zones) {
        if (zone === null || typeof zone !== "object") return null
        const value = (zone as Record<string, unknown>)[key]
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || (value as number) < 0) return null
        if (total > Number.MAX_SAFE_INTEGER - (value as number)) return null
        total += value as number
    }
    return total
}

function hasZeroTotalZoneStatistic(zones: unknown, key: string): boolean {
    if (!Array.isArray(zones) || zones.length === 0) return false
    let total = 0
    for (const zone of zones) {
        if (zone === null || typeof zone !== "object") return false
        const value = (zone as Record<string, unknown>)[key]
        if (!Number.isSafeInteger(value) || (value as number) < 0) return false
        if (total > Number.MAX_SAFE_INTEGER - (value as number)) return false
        total += value as number
    }
    return total === 0
}

export function getMatchedAwakeRaceMissionIds(
    ctx: QuestPartyFactContext,
    raceKey: string,
): number[] {
    if (ctx.party.characters[0]?.id !== REQUIRED_RACE_MISSION.leaderCharacterId) return []
    const partyRaces = new Set(raceKey.split("+").filter(Boolean))
    return REQUIRED_RACE_MISSION.requiredRaces.every(race => partyRaces.has(race))
        ? [REQUIRED_RACE_MISSION.missionId]
        : []
}

export function isBondTokenMissionComplete(
    bondTokens: readonly { status: number }[] | undefined,
): boolean {
    return bondTokens !== undefined
        && bondTokens.length > 0
        && bondTokens.every(bondToken => bondToken.status >= 2)
}

function validateAwakeBattleRuleSchemas(): void {
for (const rule of EXACT_QUEST_RULES) {
    const expectedPattern = rule.timeLimitMs === undefined
        ? rule.missionId === 1110013 ? "93" : "23"
        : "15"
    assertAwakeMissionFields(rule.missionId, {
        4: expectedPattern,
        23: String(rule.leaderCharacterId),
    })
}
assertAwakeMissionFields(1110013, { 7: "1", 9: "2", 10: "1", 11: "28", 13: "4" })
assertAwakeMissionFields(1310052, { 7: "1", 9: "11", 12: "25" })
assertAwakeMissionFields(2110013, { 7: "3", 9: "2", 10: "1", 11: "28", 13: "4" })
assertAwakeMissionFields(2310013, { 9: "14", 10: "1", 12: "6" })
assertAwakeMissionFields(2510032, { 7: "1", 9: "7", 10: "1", 12: "38" })
assertAwakeMissionFields(2510033, { 9: "7", 10: "1", 12: "38" })
assertAwakeMissionFields(2630023, { 7: "1", 9: "9", 10: "400001", 12: "104" })
assertAwakeMissionFields(13, { 4: "28", 5: "1", 7: "3", 23: "1" })
assertAwakeMissionFields(1210012, { 4: "28", 5: "1", 7: "3", 23: "121001" })
assertAwakeMissionFields(1210013, { 4: "30", 7: "3", 23: "121001" })
assertAwakeMissionFields(2410633, { 4: "93", 7: "3", 24: "241063,243007,361009" })
}
