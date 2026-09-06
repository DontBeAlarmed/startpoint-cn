import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import type { AssetCharacter } from "./types"

export interface CharacterLookupEntry {
    readonly name: string
    readonly title: string
    readonly rarity: string
    readonly element: string
}

export type CharacterLookup = Readonly<Record<string, CharacterLookupEntry>>

export interface CharacterFactsEntry {
    readonly rarity: number
    readonly element: number
    readonly skillCount: number
}

/**
 * Limited static character facts (rarity/element/skill count/races). Never
 * carries player character state; owners read their own player tables.
 */
export interface CharacterFacts {
    exists(characterId: number | string): boolean
    get(characterId: number | string): CharacterFactsEntry | null
    races(characterId: number | string): string[]
    getCharacterCount(): number
}

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

function asCharacterFactsTable(value: unknown): Record<string, AssetCharacter> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Invalid character content table.")
    }
    return value as Record<string, AssetCharacter>
}

export function buildCharacterFacts(
    repository: ReadonlyContentRepository,
): CharacterFacts {
    const table = asCharacterFactsTable(repository.table("character.json"))
    let contentTable: Readonly<Record<string, unknown>> | null = null
    const readContentTable = (): Readonly<Record<string, unknown>> => {
        if (contentTable === null) {
            contentTable = asRecord(repository.table<unknown>("cdndata/character.json"))
        }
        return contentTable
    }
    const facts: CharacterFacts = {
        exists: characterId => Object.prototype.hasOwnProperty.call(table, String(characterId)),
        get: characterId => {
            const entry = table[String(characterId)]
            return entry === undefined ? null : Object.freeze({
                rarity: entry.rarity,
                element: entry.element,
                skillCount: entry.skill_count,
            })
        },
        races: characterId => {
            const fields = firstFields(readContentTable(), String(characterId))
            const raceText = nonEmptyText(fields[4])
            if (raceText === "") return []
            return raceText.split(",").map(race => race.trim()).filter(race => race !== "")
        },
        getCharacterCount: () => Object.keys(table).length,
    }
    return Object.freeze(facts)
}

const factsByRepository = new WeakMap<ReadonlyContentRepository, CharacterFacts>()

export function getCharacterFacts(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): CharacterFacts {
    const cached = factsByRepository.get(repository)
    if (cached !== undefined) return cached
    const facts = buildCharacterFacts(repository)
    factsByRepository.set(repository, facts)
    return facts
}

export function getCharacterRacesFromRepository(
    repository: ReadonlyContentRepository,
    characterId: number | string,
): string[] {
    return getCharacterFacts(repository).races(characterId)
}
