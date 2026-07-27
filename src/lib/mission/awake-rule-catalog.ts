import charAwakeDefs from "../../../assets/mission_char_awake.json"

export type AwakeMissionRuleFamilyName =
    | "all-complete"
    | "bond-token"
    | "exact-quest-atomic"
    | "exact-quest-history"
    | "generic-character-clear"
    | "leader-clear"
    | "leader-combo"
    | "leader-coop"
    | "leader-powerflip"
    | "mana-total"
    | "no-death"
    | "quest-range-character"
    | "race-selector"
    | "same-party-quest"
    | "same-party-three"
    | "same-party-two"
    | "story-read"
    | "total-story-read"

export interface AwakeMissionRuleFamily {
    readonly family: AwakeMissionRuleFamilyName
    readonly status: "resolved" | "fail-closed"
    readonly missionIds: readonly number[]
    readonly reason?: string
}

export interface AwakeGenericCharacterClearRule {
    readonly missionId: number
    readonly characterId: number
}

type AwakeDefinitionMap = Record<string, readonly (readonly string[])[]>

const definitions = charAwakeDefs as AwakeDefinitionMap

const GENERIC_CHARACTER_CLEAR_MISSION_IDS = Object.freeze([
    1110012, 1110031, 1110032, 1110033, 1210051, 1210052, 1210053,
    1310041, 1310042, 1310043, 1410011, 1410012, 1410013,
    1510071, 1510072, 1510073, 1610011, 1610012, 1610013,
    2110021, 2110022, 2110023, 2210011, 2210012, 2210013,
    2310061, 2310062, 2310063, 2410021, 2410022, 2410023,
    2510061, 2510062, 2510063, 2610031, 2610032, 2610033,
    3110021, 3110022, 3110023, 3210091, 3210092, 3210093,
    3310021, 3310022, 3310023, 3410051, 3410052, 3410053,
    3510011, 3510012, 3510013, 3610021, 3610022, 3610023,
])

function getMissionIdsByPattern(pattern: string): readonly number[] {
    return Object.entries(definitions)
        .filter(([, rows]) => rows.length === 1 && rows[0][4] === pattern)
        .map(([missionId]) => Number(missionId))
        .sort((left, right) => left - right)
}

export const AWAKE_GENERIC_CHARACTER_CLEAR_RULES: readonly AwakeGenericCharacterClearRule[] =
    Object.freeze(GENERIC_CHARACTER_CLEAR_MISSION_IDS.map(missionId => {
        const row = getAwakeMissionDefinitionRow(missionId)
        return Object.freeze({ missionId, characterId: Number(row[1]) })
    }))

export const AWAKE_GENERIC_CHARACTER_CLEAR_MISSION_IDS = new Set(
    GENERIC_CHARACTER_CLEAR_MISSION_IDS,
)

export const AWAKE_MISSION_RULE_FAMILIES: readonly AwakeMissionRuleFamily[] = Object.freeze([
    family("all-complete", getMissionIdsByPattern("13")),
    family("bond-token", [1410033, 2210043, 2510043, 2610073]),
    family("exact-quest-atomic", [
        1110013, 1310052, 2110013, 2310013, 2510032, 2510033, 2630023,
    ]),
    family("exact-quest-history", [1410032]),
    family("generic-character-clear", GENERIC_CHARACTER_CLEAR_MISSION_IDS),
    family("leader-clear", [1610023]),
    family("leader-combo", [1210013]),
    family("leader-coop", [1310053, 1510063]),
    family("leader-powerflip", [13, 1210012]),
    family("mana-total", [2630022]),
    family("quest-range-character", [3210132, 3210133, 3410012, 3410013]),
    family("race-selector", [2310012]),
    family("same-party-quest", [1510062, 3310032, 3310033]),
    family("same-party-three", [2410633]),
    family("same-party-two", [2110012, 2210042, 2410632, 2510042]),
    family("no-death", [1610022, 2610072]),
    family("story-read", getMissionIdsByPattern("96")),
    family("total-story-read", [12]),
])

export const AWAKE_FAIL_CLOSED_MISSION_IDS = new Set(
    AWAKE_MISSION_RULE_FAMILIES
        .filter(entry => entry.status === "fail-closed")
        .flatMap(entry => entry.missionIds),
)

export function getAwakeMissionIdsByFamily(
    name: AwakeMissionRuleFamilyName,
): readonly number[] {
    const entry = AWAKE_MISSION_RULE_FAMILIES.find(familyEntry => familyEntry.family === name)
    if (!entry) throw new TypeError(`Unknown Character Awake mission rule family ${name}.`)
    return entry.missionIds
}

function family(
    name: AwakeMissionRuleFamilyName,
    missionIds: readonly number[],
    reason?: string,
): AwakeMissionRuleFamily {
    return Object.freeze({
        family: name,
        status: reason === undefined ? "resolved" : "fail-closed",
        missionIds: Object.freeze([...missionIds]),
        ...(reason === undefined ? {} : { reason }),
    })
}

export function getAwakeMissionDefinitionRow(missionId: number): readonly string[] {
    const rows = definitions[String(missionId)]
    if (!rows || rows.length !== 1) {
        throw new TypeError(`Character Awake mission ${missionId} must have exactly one master-data row.`)
    }
    return rows[0]
}

export function assertAwakeMissionFields(
    missionId: number,
    expected: Readonly<Record<number, string>>,
): void {
    const row = getAwakeMissionDefinitionRow(missionId)
    for (const [indexText, value] of Object.entries(expected)) {
        const index = Number(indexText)
        if (row[index] !== value) {
            throw new TypeError(
                `Character Awake mission ${missionId} field ${index} expected ${JSON.stringify(value)}, got ${JSON.stringify(row[index])}.`,
            )
        }
    }
}

function validateGenericCharacterClearRules(): void {
    const emptySelectors = [
        "", "", "3", "", "(None)", "", "", "", "(None)",
        "(None)", "(None)", "(None)", "(None)", "", "", "(None)",
        "(None)", "(None)", "(None)",
    ]
    for (const rule of AWAKE_GENERIC_CHARACTER_CLEAR_RULES) {
        const row = getAwakeMissionDefinitionRow(rule.missionId)
        if (row[4] !== "93"
            || row.slice(5, 24).some((value, index) => value !== emptySelectors[index])
            || row[24] !== row[1]
            || row[25] !== ""
            || row[26] !== ""
            || Number(row[1]) !== rule.characterId) {
            throw new TypeError(`Character Awake generic rule ${rule.missionId} no longer matches the audited schema.`)
        }
    }
}

function validateRulePartition(): void {
    const expectedMissionIds = Object.keys(definitions)
        .map(Number)
        .sort((left, right) => left - right)
    const actualMissionIds = AWAKE_MISSION_RULE_FAMILIES
        .flatMap(entry => entry.missionIds)
        .sort((left, right) => left - right)
    if (actualMissionIds.length !== expectedMissionIds.length
        || new Set(actualMissionIds).size !== actualMissionIds.length
        || actualMissionIds.some((missionId, index) => missionId !== expectedMissionIds[index])) {
        throw new TypeError("Character Awake mission rule families must partition official master data exactly once.")
    }

    assertAwakeMissionFields(2310012, { 4: "94", 7: "3", 23: "231001", 25: "Human,Dragon,Devil" })
    for (const [missionId, leaderCharacterId] of [[1610022, 161002], [2610072, 261007]]) {
        assertAwakeMissionFields(missionId, {
            4: "95",
            5: "17",
            7: "3",
            23: String(leaderCharacterId),
        })
    }
}

function validateResolvedFamilySchemas(): void {
    assertAwakeMissionFields(12, { 4: "21" })
    assertAwakeMissionFields(1410032, { 4: "23", 7: "3", 9: "2", 10: "1", 11: "20", 12: "3" })
    assertAwakeMissionFields(1610023, { 4: "23", 7: "3", 23: "161002" })
    assertAwakeMissionFields(2630022, { 4: "2" })

    for (const [missionId, characterId] of [
        [1410033, 141003],
        [2210043, 221004],
        [2510043, 251004],
        [2610073, 261007],
    ]) {
        assertAwakeMissionFields(missionId, { 4: "48", 16: String(characterId) })
    }

    for (const [missionId, leaderId] of [[1310053, 131005], [1510063, 151006]]) {
        assertAwakeMissionFields(missionId, { 4: "93", 7: "2", 23: String(leaderId), 24: "" })
    }

    for (const [missionId, characterIds] of ([
        [2110012, "211001,231001"],
        [2210042, "10,221004"],
        [2410632, "241063,243007"],
        [2510042, "251004,1"],
    ] as const)) {
        assertAwakeMissionFields(missionId, { 4: "93", 7: "3", 23: "(None)", 24: characterIds })
    }

    assertAwakeMissionFields(1510062, { 4: "93", 7: "3", 23: "151006", 24: "263002" })
    assertAwakeMissionFields(3310032, { 4: "93", 7: "1", 9: "11", 12: "5", 24: "331003,1" })
    assertAwakeMissionFields(3310033, { 4: "93", 7: "1", 9: "2", 10: "1", 11: "10", 13: "4", 24: "331003,10" })

    assertAwakeMissionFields(3210132, { 4: "93", 7: "1", 9: "12", 24: "321013" })
    assertAwakeMissionFields(3210133, { 4: "93", 7: "1", 9: "7", 10: "2", 12: "1,2,3,4,5,6", 24: "321013" })
    assertAwakeMissionFields(3410012, { 4: "93", 7: "1", 9: "12", 24: "341001" })
    assertAwakeMissionFields(3410013, { 4: "93", 7: "1", 9: "7", 10: "1", 12: "40", 24: "341001" })
}

validateGenericCharacterClearRules()
validateRulePartition()
validateResolvedFamilySchemas()
