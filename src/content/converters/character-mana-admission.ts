import { deepFreeze } from "../deep-freeze"
import {
    parseCharacterLevelBundledSeed,
} from "../character-level-seed"
import { validateCharacterLevelCurve } from "../character-level-table-validator"
import {
    parseNestedOrderedMapRows,
    parseTextOrderedMap,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const LEVEL_REQUIRED_PATH = "master/mana_board/level_required_mana_node.orderedmap"
const CHARACTER_LEVEL_PATH = "master/character/character_level.orderedmap"
const POSITIVE_INTEGER = /^[1-9]\d*$/
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/

export interface CharacterManaAdmissionSourceReader {
    readBytes(logicalPath: string): Promise<Buffer>
}

export interface CharacterManaAdmissionConversionCompatibility {
    readonly characterLevelBundledSeed: unknown
}

export interface LevelRequiredManaNodeRow {
    readonly abilityLevels: readonly [
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
    ]
    readonly skillEvolutionLevel: number | null
}

export interface CharacterManaAdmissionConversionOutput {
    readonly "level_required_mana_node.json": Readonly<Record<string, LevelRequiredManaNodeRow>>
    readonly "character_level.json": Readonly<Record<string, Readonly<Record<string, number>>>>
}

function invalid(table: string, reason: string): never {
    throw new Error(`invalid ${table} content: ${reason}`)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index])
}

function positiveKey(value: string, subject: string, table: string): number {
    if (!POSITIVE_INTEGER.test(value)) invalid(table, `${subject} must be canonical`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalid(table, `${subject} must be a safe integer`)
    return parsed
}

function positiveOption(value: string, subject: string): number | null {
    if (value === "(None)") return null
    if (!POSITIVE_INTEGER.test(value)) {
        invalid("level required mana node", `${subject} must be a positive safe integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalid("level required mana node", `${subject} must be a positive safe integer`)
    }
    return parsed
}

function cumulativeExperience(value: string, subject: string): number {
    if (!NON_NEGATIVE_INTEGER.test(value)) {
        invalid("character level", `${subject} must be a non-negative safe integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalid("character level", `${subject} must be a non-negative safe integer`)
    }
    return parsed
}

function convertLevelRequirements(raw: Buffer): Record<string, LevelRequiredManaNodeRow> {
    const result: Record<string, LevelRequiredManaNodeRow> = {}
    for (const row of parseTextOrderedMap(raw)) {
        const rarity = positiveKey(row.key, `rarity ${row.key}`, "level required mana node")
        if (rarity > 5) invalid("level required mana node", "rarity must be 1 through 5")
        const fields = parseCsvLine(row.text, `rarity ${rarity}`, reason => (
            invalid("level required mana node", reason)
        ))
        if (fields.length !== 7) {
            invalid("level required mana node", `rarity ${rarity} must have 7 columns`)
        }
        result[row.key] = {
            abilityLevels: fields.slice(0, 6).map((value, index) => (
                positiveOption(value, `rarity ${rarity} ability_${index + 1}`)
            )) as unknown as LevelRequiredManaNodeRow["abilityLevels"],
            skillEvolutionLevel: positiveOption(fields[6], `rarity ${rarity} skill_evolution`),
        }
    }
    if (Object.keys(result).sort().join(",") !== "1,2,3,4,5") {
        invalid("level required mana node", "table must contain rarities 1 through 5")
    }
    return result
}

function convertCharacterLevels(raw: Buffer): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {}
    for (const rarityRow of parseNestedOrderedMapRows(raw)) {
        const rarity = positiveKey(rarityRow.key, `rarity ${rarityRow.key}`, "character level")
        if (rarity > 5 || result[rarityRow.key]) {
            invalid("character level", `rarity ${rarityRow.key} is invalid or duplicated`)
        }
        const curve: Record<string, number> = {}
        for (const levelRow of parseTextOrderedMap(rarityRow.value)) {
            const level = positiveKey(levelRow.key, `rarity ${rarity} level`, "character level")
            const fields = parseCsvLine(levelRow.text, `rarity ${rarity} level ${level}`, reason => (
                invalid("character level", reason)
            ))
            if (fields.length !== 1) {
                invalid("character level", `rarity ${rarity} level ${level} must have 1 column`)
            }
            const total = cumulativeExperience(fields[0], `rarity ${rarity} level ${level}`)
            curve[levelRow.key] = total
        }
        try {
            result[rarityRow.key] = validateCharacterLevelCurve(
                curve,
                `character level rarity ${rarity}`,
            )
        } catch (error) {
            invalid("character level", error instanceof Error ? error.message : String(error))
        }
    }
    if (Object.keys(result).length === 0) invalid("character level", "table is empty")
    return result
}

export async function convertCharacterManaAdmissionTables(
    reader: CharacterManaAdmissionSourceReader,
    compatibility: CharacterManaAdmissionConversionCompatibility,
): Promise<CharacterManaAdmissionConversionOutput> {
    const requirements = convertLevelRequirements(await reader.readBytes(LEVEL_REQUIRED_PATH))
    const ordinary = convertCharacterLevels(await reader.readBytes(CHARACTER_LEVEL_PATH))
    let bundled: Record<string, Record<string, number>>
    try {
        bundled = parseCharacterLevelBundledSeed(compatibility?.characterLevelBundledSeed)
    } catch (error) {
        invalid("character level bundled seed", error instanceof Error ? error.message : String(error))
    }
    const duplicate = Object.keys(ordinary).find(rarity => bundled[rarity] !== undefined)
    if (duplicate) invalid("character level", `duplicate rarity ${duplicate} across source shards`)
    if (!exactKeys(ordinary, ["1", "2"])) {
        invalid("character level", "ordinary shard must contain rarities 1 and 2")
    }
    const levels = { ...ordinary, ...bundled }
    if (!exactKeys(levels, ["1", "2", "3", "4", "5"])) {
        invalid("character level", "merged table must contain rarities 1 through 5")
    }
    return deepFreeze({
        "level_required_mana_node.json": requirements,
        "character_level.json": levels,
    })
}
