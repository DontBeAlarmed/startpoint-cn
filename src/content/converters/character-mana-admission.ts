import { deepFreeze } from "../deep-freeze"
import { canonicalJsonBuffer, sha256Object } from "../sync/canonical-json"
import {
    parseNestedOrderedMapRows,
    parseTextOrderedMap,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const LEVEL_REQUIRED_PATH = "master/mana_board/level_required_mana_node.orderedmap"
const CHARACTER_LEVEL_PATH = "master/character/character_level.orderedmap"
const BUNDLED_ARCHIVE_PATH =
    "production/android_bundle/23/a83b55daad153a95f8d5b66667b32e47f3dca2"
const BUNDLED_BLOB_SHA256 =
    "eb21a7fe67d9f58730235ce276d1421b26a14cb84e7d27fd35cb2e0cae2b3565"
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

function record(value: unknown, subject: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalid("character level bundled seed", `${subject} must be an object`)
    }
    return value as Record<string, unknown>
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
        let expectedLevel = 1
        let previous = -1
        for (const levelRow of parseTextOrderedMap(rarityRow.value)) {
            const level = positiveKey(levelRow.key, `rarity ${rarity} level`, "character level")
            if (level !== expectedLevel) {
                invalid("character level", `rarity ${rarity} levels must be contiguous from 1`)
            }
            const fields = parseCsvLine(levelRow.text, `rarity ${rarity} level ${level}`, reason => (
                invalid("character level", reason)
            ))
            if (fields.length !== 1) {
                invalid("character level", `rarity ${rarity} level ${level} must have 1 column`)
            }
            const total = cumulativeExperience(fields[0], `rarity ${rarity} level ${level}`)
            if ((level === 1 && total !== 0) || (level > 1 && total <= previous)) {
                invalid("character level", `rarity ${rarity} curve must be strictly increasing from zero`)
            }
            curve[levelRow.key] = total
            previous = total
            expectedLevel += 1
        }
        if (expectedLevel !== 101) {
            invalid("character level", `rarity ${rarity} must contain exactly levels 1 through 100`)
        }
        result[rarityRow.key] = curve
    }
    if (Object.keys(result).length === 0) invalid("character level", "table is empty")
    return result
}

function parseBundledCurve(value: unknown, rarity: string): Record<string, number> {
    if (!Array.isArray(value) || value.length !== 100) {
        invalid("character level bundled seed", `rarity ${rarity} must contain 100 levels`)
    }
    const result: Record<string, number> = {}
    let previous = -1
    value.forEach((rawTotal, index) => {
        const level = index + 1
        if (typeof rawTotal !== "number"
            || !Number.isSafeInteger(rawTotal)
            || rawTotal < 0
            || (level === 1 && rawTotal !== 0)
            || (level > 1 && rawTotal <= previous)) {
            invalid(
                "character level bundled seed",
                `rarity ${rarity} curve must be safe and strictly increasing from zero`,
            )
        }
        result[String(level)] = rawTotal
        previous = rawTotal
    })
    return result
}

function parseBundledSeed(value: unknown): Record<string, Record<string, number>> {
    const seed = record(value, "seed")
    if (!exactKeys(seed, ["schemaVersion", "source", "summary", "curves"])
        || seed.schemaVersion !== 1) {
        invalid("character level bundled seed", "schemaVersion or top-level shape is invalid")
    }

    const source = record(seed.source, "source")
    if (!exactKeys(source, ["archiveLogicalPath", "blobSha256"])
        || source.archiveLogicalPath !== BUNDLED_ARCHIVE_PATH
        || source.blobSha256 !== BUNDLED_BLOB_SHA256) {
        invalid("character level bundled seed", "source metadata is invalid")
    }

    const curves = record(seed.curves, "curves")
    if (!exactKeys(curves, ["3", "4", "5"])) {
        invalid("character level bundled seed", "curves must contain rarities 3 through 5")
    }
    const result = Object.fromEntries(["3", "4", "5"].map(rarity => (
        [rarity, parseBundledCurve(curves[rarity], rarity)]
    )))

    const summary = record(seed.summary, "summary")
    if (!exactKeys(summary, ["rarities", "levelsPerRarity", "curves"])
        || !Array.isArray(summary.rarities)
        || summary.rarities.length !== 3
        || summary.rarities.some((rarity, index) => rarity !== index + 3)
        || summary.levelsPerRarity !== 100) {
        invalid("character level bundled seed", "summary shape is invalid")
    }
    const curveSummaries = record(summary.curves, "summary curves")
    if (!exactKeys(curveSummaries, ["3", "4", "5"])) {
        invalid("character level bundled seed", "summary curves must contain rarities 3 through 5")
    }
    for (const rarity of ["3", "4", "5"]) {
        const curveSummary = record(curveSummaries[rarity], `rarity ${rarity} summary`)
        const curve = result[rarity]
        if (!exactKeys(curveSummary, ["level80", "level90", "level100", "digest"])
            || curveSummary.level80 !== curve["80"]
            || curveSummary.level90 !== curve["90"]
            || curveSummary.level100 !== curve["100"]
            || curveSummary.digest !== sha256Object(canonicalJsonBuffer(curve))) {
            invalid("character level bundled seed", `rarity ${rarity} summary is invalid`)
        }
    }
    return result
}

export async function convertCharacterManaAdmissionTables(
    reader: CharacterManaAdmissionSourceReader,
    compatibility: CharacterManaAdmissionConversionCompatibility,
): Promise<CharacterManaAdmissionConversionOutput> {
    const requirements = convertLevelRequirements(await reader.readBytes(LEVEL_REQUIRED_PATH))
    const ordinary = convertCharacterLevels(await reader.readBytes(CHARACTER_LEVEL_PATH))
    const bundled = parseBundledSeed(compatibility?.characterLevelBundledSeed)
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
