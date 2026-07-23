import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"

export interface CharacterLookupEntry {
    readonly name: string
    readonly title: string
    readonly rarity: string
    readonly element: string
}

export type CharacterLookup = Readonly<Record<string, CharacterLookupEntry>>

interface CharacterMetadata {
    readonly name?: unknown
    readonly rarity?: unknown
    readonly element?: unknown
}

const ELEMENT_NAMES: Readonly<Record<number, string>> = Object.freeze({
    0: "火",
    1: "水",
    2: "雷",
    3: "风",
    4: "光",
    5: "暗",
})

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {}
}

function firstFields(
    table: Readonly<Record<string, unknown>>,
    characterId: string,
): readonly unknown[] {
    const rows = table[characterId]
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return []
    return rows[0]
}

function nonEmptyText(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

function numericValue(value: unknown): number | null {
    const number = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN
    return Number.isFinite(number) ? number : null
}

export function buildCharacterLookup(
    repository: ReadonlyContentRepository,
): CharacterLookup {
    const metadataTable = asRecord(repository.table<unknown>("character.json"))
    const contentTable = asRecord(repository.table<unknown>("cdndata/character.json"))
    const textTable = asRecord(repository.table<unknown>("cdndata/character_text.json"))
    const lookup: Record<string, CharacterLookupEntry> = {}

    for (const [characterId, rawMetadata] of Object.entries(metadataTable)) {
        const metadata = asRecord(rawMetadata) as CharacterMetadata
        const contentFields = firstFields(contentTable, characterId)
        const textFields = firstFields(textTable, characterId)
        const rarity = numericValue(metadata.rarity) ?? numericValue(contentFields[2])
        const element = numericValue(metadata.element) ?? numericValue(contentFields[3])

        lookup[characterId] = {
            name: nonEmptyText(textFields[0]) || nonEmptyText(metadata.name) || "?",
            title: nonEmptyText(contentFields[18]),
            rarity: rarity === null ? "-" : `${rarity}★`,
            element: element === null ? "未知" : ELEMENT_NAMES[element] ?? "未知",
        }
    }

    return lookup
}

export function getCharacterLookup(): CharacterLookup {
    return buildCharacterLookup(getContentSnapshot().repository)
}

export function getCharacterRacesFromRepository(
    repository: ReadonlyContentRepository,
    characterId: number | string,
): string[] {
    const contentTable = asRecord(repository.table<unknown>("cdndata/character.json"))
    const fields = firstFields(contentTable, String(characterId))
    const raceText = nonEmptyText(fields[4])
    if (raceText === "") return []
    return raceText.split(",").map(race => race.trim()).filter(race => race !== "")
}
