import { createHash } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import { canonicalJsonBuffer, sha256Object } from "./sync/canonical-json"
import { convertOrderedMapJson } from "./converters/ordered-map-json"
import {
    CHARACTER_LEVEL_KEYS,
    validateCharacterLevelCurve,
} from "./character-level-table-validator"

export const CHARACTER_LEVEL_SEED_TABLE = "content-seeds/character_level_apk_3_5.json"
export const CHARACTER_LEVEL_SEED_ASSET_PATH =
    "assets/content-seeds/character_level_apk_3_5.json"
export const CHARACTER_LEVEL_BUNDLED_ARCHIVE_PATH =
    "production/android_bundle/23/a83b55daad153a95f8d5b66667b32e47f3dca2"
export const CHARACTER_LEVEL_BUNDLED_BLOB_SHA256 =
    "eb21a7fe67d9f58730235ce276d1421b26a14cb84e7d27fd35cb2e0cae2b3565"

type CharacterLevelSeedCurves = Readonly<Record<string, Readonly<Record<string, number>>>>

function invalid(reason: string): never {
    throw new Error(`invalid character level seed content: ${reason}`)
}

function record(value: unknown, subject: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalid(`${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index])
}

function parseCurve(value: unknown, rarity: string): Record<string, number> {
    if (!Array.isArray(value) || value.length !== 100) {
        invalid(`rarity ${rarity} must contain exactly 100 levels`)
    }
    const expanded = Object.fromEntries(CHARACTER_LEVEL_KEYS.map((level, index) => (
        [level, value[index]]
    )))
    try {
        return validateCharacterLevelCurve(expanded, `rarity ${rarity} curve`)
    } catch (error) {
        invalid(error instanceof Error ? error.message : String(error))
    }
}

function parseSourceCurve(value: unknown, rarity: string): Record<string, number> {
    const source = record(value, `source rarity ${rarity}`)
    if (!exactKeys(source, CHARACTER_LEVEL_KEYS)) {
        invalid(`source rarity ${rarity} must contain exactly levels 1 through 100`)
    }
    const expanded = Object.fromEntries(CHARACTER_LEVEL_KEYS.map(level => {
        const row = source[level]
        if (!Array.isArray(row)
            || row.length !== 1
            || !Array.isArray(row[0])
            || row[0].length !== 1
            || typeof row[0][0] !== "string") {
            invalid(`source rarity ${rarity} level ${level} must contain one CSV value`)
        }
        if (!/^\d+$/.test(row[0][0])) {
            invalid(`source rarity ${rarity} level ${level} must be a decimal integer`)
        }
        const value = Number(row[0][0])
        if (!Number.isSafeInteger(value)) {
            invalid(`source rarity ${rarity} level ${level} must be a safe integer`)
        }
        return [level, value]
    }))
    try {
        return validateCharacterLevelCurve(expanded, `source rarity ${rarity} curve`)
    } catch (error) {
        invalid(error instanceof Error ? error.message : String(error))
    }
}

export function parseCharacterLevelBundledSourceBlob(
    sourceBlob: Buffer,
): CharacterLevelSeedCurves {
    if (!Buffer.isBuffer(sourceBlob)) invalid("source blob must be a Buffer")

    let decoded: Buffer
    try {
        decoded = inflateRawSync(sourceBlob)
    } catch (error) {
        invalid(`source blob is not a raw-deflate orderedmap: ${error instanceof Error ? error.message : String(error)}`)
    }

    let extracted: unknown
    try {
        extracted = convertOrderedMapJson(decoded, 2)
    } catch (error) {
        invalid(`source blob orderedmap is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const source = record(extracted, "source character level table")
    if (!exactKeys(source, ["3", "4", "5"])) {
        invalid("source character level table must contain rarities 3 through 5")
    }
    return Object.fromEntries(["3", "4", "5"].map(rarity => (
        [rarity, parseSourceCurve(source[rarity], rarity)]
    )))
}

function sameCurves(
    left: CharacterLevelSeedCurves,
    right: CharacterLevelSeedCurves,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

export function parseCharacterLevelBundledSeed(
    value: unknown,
    sourceBlobSha256 = CHARACTER_LEVEL_BUNDLED_BLOB_SHA256,
): CharacterLevelSeedCurves {
    const seed = record(value, "seed")
    if (!exactKeys(seed, ["schemaVersion", "source", "summary", "curves"])
        || seed.schemaVersion !== 1) {
        invalid("schemaVersion or top-level shape is invalid")
    }
    const source = record(seed.source, "source")
    if (!exactKeys(source, ["archiveLogicalPath", "blobSha256"])
        || source.archiveLogicalPath !== CHARACTER_LEVEL_BUNDLED_ARCHIVE_PATH
        || source.blobSha256 !== sourceBlobSha256) {
        invalid("source metadata or blob SHA-256 is invalid")
    }

    const curves = record(seed.curves, "curves")
    if (!exactKeys(curves, ["3", "4", "5"])) {
        invalid("curves must contain rarities 3 through 5")
    }
    const parsedCurves = Object.fromEntries(["3", "4", "5"].map(rarity => (
        [rarity, parseCurve(curves[rarity], rarity)]
    )))

    const summary = record(seed.summary, "summary")
    if (!exactKeys(summary, ["rarities", "levelsPerRarity", "curves"])
        || !Array.isArray(summary.rarities)
        || summary.rarities.length !== 3
        || summary.rarities.some((rarity, index) => rarity !== index + 3)
        || summary.levelsPerRarity !== 100) {
        invalid("summary shape is invalid")
    }
    const curveSummaries = record(summary.curves, "summary curves")
    if (!exactKeys(curveSummaries, ["3", "4", "5"])) {
        invalid("summary curves must contain rarities 3 through 5")
    }
    for (const rarity of ["3", "4", "5"]) {
        const curveSummary = record(curveSummaries[rarity], `rarity ${rarity} summary`)
        const curve = parsedCurves[rarity]
        if (!exactKeys(curveSummary, ["level80", "level90", "level100", "digest"])
            || curveSummary.level80 !== curve["80"]
            || curveSummary.level90 !== curve["90"]
            || curveSummary.level100 !== curve["100"]
            || curveSummary.digest !== sha256Object(canonicalJsonBuffer(curve))) {
            invalid(`rarity ${rarity} summary is invalid`)
        }
    }
    return parsedCurves
}

export function canonicalizeCharacterLevelBundledSeed(
    value: unknown,
    sourceBlobSha256 = CHARACTER_LEVEL_BUNDLED_BLOB_SHA256,
    sourceBlob?: Buffer,
): Record<string, unknown> {
    const curves = parseCharacterLevelBundledSeed(value, sourceBlobSha256)
    if (sourceBlob !== undefined) {
        const actualBlobSha256 = createHash("sha256").update(sourceBlob).digest("hex")
        if (actualBlobSha256 !== sourceBlobSha256) {
            invalid("source blob SHA-256 does not match seed metadata")
        }
        const sourceCurves = parseCharacterLevelBundledSourceBlob(sourceBlob)
        if (!sameCurves(curves, sourceCurves)) {
            invalid("seed curves do not match source blob")
        }
    }
    return {
        schemaVersion: 1,
        source: {
            archiveLogicalPath: CHARACTER_LEVEL_BUNDLED_ARCHIVE_PATH,
            blobSha256: sourceBlobSha256,
        },
        summary: {
            rarities: [3, 4, 5],
            levelsPerRarity: 100,
            curves: Object.fromEntries(["3", "4", "5"].map(rarity => [
                rarity,
                {
                    level80: curves[rarity]["80"],
                    level90: curves[rarity]["90"],
                    level100: curves[rarity]["100"],
                    digest: sha256Object(canonicalJsonBuffer(curves[rarity])),
                },
            ])),
        },
        curves: Object.fromEntries(["3", "4", "5"].map(rarity => (
            [rarity, CHARACTER_LEVEL_KEYS.map(level => curves[rarity][level])]
        ))),
    }
}
