import { deepFreeze } from "./deep-freeze"
import type { LevelRequiredManaNodeRow } from "./converters/character-mana-admission"

export type LevelRequiredManaNodeTable = Readonly<Record<string, LevelRequiredManaNodeRow>>
export type CharacterLevelTable = Readonly<Record<string, Readonly<Record<string, number>>>>

export interface ManaNodeLevelFields {
    readonly field1: string
    readonly field5: string
    readonly field6: string
}

const POSITIVE_INTEGER = /^[1-9]\d*$/

function record(value: unknown, subject: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function positiveSafe(value: unknown, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${subject} must be a positive safe integer`)
    }
    return value
}

function optionLevel(value: unknown, subject: string): number | null {
    return value === null ? null : positiveSafe(value, subject)
}

function canonicalKey(value: string, subject: string): number {
    if (!POSITIVE_INTEGER.test(value)) throw new Error(`${subject} must be canonical`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new Error(`${subject} must be safe`)
    return parsed
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], subject: string): void {
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    if (actual.length !== sortedExpected.length
        || actual.some((key, index) => key !== sortedExpected[index])) {
        throw new Error(`${subject} has an invalid shape`)
    }
}

export function parseLevelRequiredManaNodeTable(value: unknown): LevelRequiredManaNodeTable {
    const source = record(value, "level required mana node table")
    if (Object.keys(source).sort().join(",") !== "1,2,3,4,5") {
        throw new Error("level required mana node rarity keys must be 1 through 5")
    }
    const result: Record<string, LevelRequiredManaNodeRow> = {}
    for (const [rarity, rawRow] of Object.entries(source)) {
        const row = record(rawRow, `level required mana node rarity ${rarity}`)
        exactKeys(row, ["abilityLevels", "skillEvolutionLevel"], `rarity ${rarity}`)
        if (!Array.isArray(row.abilityLevels) || row.abilityLevels.length !== 6) {
            throw new Error(`rarity ${rarity} abilityLevels must contain 6 entries`)
        }
        result[rarity] = {
            abilityLevels: row.abilityLevels.map((entry, index) => (
                optionLevel(entry, `rarity ${rarity} ability_${index + 1}`)
            )) as unknown as LevelRequiredManaNodeRow["abilityLevels"],
            skillEvolutionLevel: optionLevel(
                row.skillEvolutionLevel,
                `rarity ${rarity} skillEvolutionLevel`,
            ),
        }
    }
    return deepFreeze(result)
}

export function parseCharacterLevelTable(value: unknown): CharacterLevelTable {
    const source = record(value, "character level table")
    if (Object.keys(source).length === 0) throw new Error("character level table is empty")
    const result: Record<string, Record<string, number>> = {}
    for (const [rarityText, rawCurve] of Object.entries(source)) {
        const rarity = canonicalKey(rarityText, "character level rarity")
        if (rarity > 5) throw new Error(`character level has unknown rarity ${rarity}`)
        const curve = record(rawCurve, `character level rarity ${rarity}`)
        const resultCurve: Record<string, number> = {}
        let expectedLevel = 1
        let previous = -1
        for (const [levelText, rawTotal] of Object.entries(curve)) {
            const level = canonicalKey(levelText, `character level rarity ${rarity} level`)
            if (level !== expectedLevel) {
                throw new Error(`character level rarity ${rarity} levels must be contiguous from 1`)
            }
            if (typeof rawTotal !== "number"
                || !Number.isSafeInteger(rawTotal)
                || rawTotal < 0) {
                throw new Error(`character level rarity ${rarity} level ${level} is invalid`)
            }
            if ((level === 1 && rawTotal !== 0) || (level > 1 && rawTotal <= previous)) {
                throw new Error(`character level rarity ${rarity} must be strictly increasing from zero`)
            }
            resultCurve[levelText] = rawTotal
            expectedLevel += 1
            previous = rawTotal
        }
        if (expectedLevel === 1) throw new Error(`character level rarity ${rarity} is empty`)
        result[rarityText] = resultCurve
    }
    return deepFreeze(result)
}

export function getCharacterLevelByExperience(
    table: CharacterLevelTable,
    rarity: number,
    experience: number,
): number {
    if (!Number.isSafeInteger(rarity) || rarity <= 0 || !table[String(rarity)]) {
        throw new Error(`character level has unknown rarity ${rarity}`)
    }
    if (!Number.isSafeInteger(experience) || experience < 0) {
        throw new Error("character experience must be a non-negative safe integer")
    }
    const thresholds = Object.values(table[String(rarity)])
    let low = 0
    let high = thresholds.length - 1
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (thresholds[middle] <= experience) low = middle
        else high = middle - 1
    }
    if (thresholds[low] > experience) throw new Error("character experience is below level 1")
    return low + 1
}

export function getManaNodeRequiredLevel(
    table: LevelRequiredManaNodeTable,
    rarity: number,
    node: ManaNodeLevelFields,
): number | null {
    if (!Number.isSafeInteger(rarity) || rarity < 1 || rarity > 5) {
        throw new Error(`level required mana node has unknown rarity ${rarity}`)
    }
    const row = table[String(rarity)]
    if (!row) throw new Error(`level required mana node has unknown rarity ${rarity}`)
    if (node.field1 === "1") return null
    if (node.field1 !== "0") throw new Error(`mana node has unknown kind ${node.field1}`)
    if (node.field5 === "1" || node.field5 === "2") return row.skillEvolutionLevel
    if (node.field5 !== "0" || !/^[1-6]$/.test(node.field6)) {
        throw new Error(`mana node has invalid ability effect ${node.field5}:${node.field6}`)
    }
    return row.abilityLevels[Number(node.field6) - 1]
}
