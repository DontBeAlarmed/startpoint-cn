import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import type { Element } from "../../lib/types/quest"

const CHARACTER_COLUMN_COUNT = 37
const CHARACTER_TEXT_COLUMN_COUNT = 12
const CHARACTER_RARITY_COLUMN = 2
const CHARACTER_ELEMENT_COLUMN = 3
const CHARACTER_SKILLS_COLUMN = 36

const CHARACTER_ID_PATTERN = /^[1-9]\d*$/
const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/

export interface ReadonlyAssetCharacter {
    readonly name: string
    readonly rarity: number
    readonly element: Element
    readonly skill_count: number
}

export type ReadonlyRawAssetCharacters = Readonly<
    Record<string, ReadonlyAssetCharacter>
>

type ReadonlyCdnCharacterRows = Readonly<
    Record<string, readonly (readonly string[])[]>
>

export interface CharacterConversionInput {
    readonly characterRows: readonly OrderedMapTextRow[]
    readonly characterTextRows: readonly OrderedMapTextRow[]
}

export interface CharacterConversionOutput {
    readonly "character.json": ReadonlyRawAssetCharacters
    readonly "cdndata/character.json": ReadonlyCdnCharacterRows
    readonly "cdndata/character_text.json": ReadonlyCdnCharacterRows
}

function invalidCharacter(reason: string): never {
    throw new Error(`invalid character content: ${reason}`)
}

function parseCsvLine(text: string, subject: string): string[] {
    const fields: string[] = []
    let field = ""
    let state: "start" | "unquoted" | "quoted" | "after-quote" = "start"

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (state === "start") {
            if (character === "\r" || character === "\n") {
                invalidCharacter(`${subject} must be a single CSV line outside quoted fields`)
            }
            if (character === ",") fields.push("")
            else if (character === '"') state = "quoted"
            else {
                field = character
                state = "unquoted"
            }
            continue
        }
        if (state === "unquoted") {
            if (character === "\r" || character === "\n") {
                invalidCharacter(`${subject} must be a single CSV line outside quoted fields`)
            }
            if (character === ",") {
                fields.push(field)
                field = ""
                state = "start"
            } else if (character === '"') {
                invalidCharacter(`${subject} has an illegal quote`)
            } else {
                field += character
            }
            continue
        }
        if (state === "quoted") {
            // 官方 1.4.54 的部分 character_text 字段在引号内包含真实换行。
            if (character !== '"') {
                field += character
            } else if (text[index + 1] === '"') {
                field += '"'
                index += 1
            } else {
                state = "after-quote"
            }
            continue
        }
        if (character === "\r" || character === "\n") {
            invalidCharacter(`${subject} must be a single CSV line outside quoted fields`)
        }
        if (character !== ",") {
            invalidCharacter(`${subject} has data after a closing quote`)
        }
        fields.push(field)
        field = ""
        state = "start"
    }

    if (state === "quoted") invalidCharacter(`${subject} has an unclosed quote`)
    fields.push(field)
    return fields
}

function parseInteger(value: string, subject: string): number {
    if (!INTEGER_PATTERN.test(value)) invalidCharacter(`${subject} must be an integer`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidCharacter(`${subject} must be a safe integer`)
    return parsed
}

function parseSkillCount(value: string, subject: string): number {
    if (value.length === 0) invalidCharacter(`${subject} must be a non-empty integer list`)
    return value.split(",").map((entry, index) => {
        if (!NON_NEGATIVE_INTEGER_PATTERN.test(entry)) {
            invalidCharacter(`${subject}[${index}] must be a non-negative integer`)
        }
        const parsed = Number(entry)
        if (!Number.isSafeInteger(parsed)) {
            invalidCharacter(`${subject}[${index}] must be a safe integer`)
        }
        return parsed
    }).filter(skill => skill === 6).length
}

function compareIds(left: OrderedMapTextRow, right: OrderedMapTextRow): number {
    const lengthDifference = left.key.length - right.key.length
    if (lengthDifference !== 0) return lengthDifference
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
}

function requireRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): Array<readonly [string, string[]]> {
    const seen = new Set<string>()
    return [...rows].sort(compareIds).map((row) => {
        if (!CHARACTER_ID_PATTERN.test(row.key)) {
            invalidCharacter(`${tableName} key must be a canonical positive integer: ${row.key}`)
        }
        if (seen.has(row.key)) invalidCharacter(`${tableName} has duplicate key: ${row.key}`)
        seen.add(row.key)

        const fields = parseCsvLine(row.text, `${tableName}[${row.key}]`)
        if (fields.length !== columnCount) {
            invalidCharacter(
                `${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`,
            )
        }
        return [row.key, fields] as const
    })
}

export function convertCharacters(input: CharacterConversionInput): CharacterConversionOutput {
    const characterEntries = requireRows(
        input.characterRows,
        "character",
        CHARACTER_COLUMN_COUNT,
    )
    const characterTextEntries = requireRows(
        input.characterTextRows,
        "character_text",
        CHARACTER_TEXT_COLUMN_COUNT,
    )

    const characters: Record<string, ReadonlyAssetCharacter> = {}
    const cdnCharacters: Record<string, string[][]> = {}
    for (const [key, fields] of characterEntries) {
        characters[key] = {
            name: "",
            rarity: parseInteger(fields[CHARACTER_RARITY_COLUMN], `character[${key}].rarity`),
            element: parseInteger(
                fields[CHARACTER_ELEMENT_COLUMN],
                `character[${key}].element`,
            ) as Element,
            skill_count: parseSkillCount(
                fields[CHARACTER_SKILLS_COLUMN],
                `character[${key}].skills`,
            ),
        }
        cdnCharacters[key] = [fields]
    }

    const cdnCharacterText: Record<string, string[][]> = {}
    for (const [key, fields] of characterTextEntries) cdnCharacterText[key] = [fields]

    return deepFreeze({
        "character.json": characters,
        "cdndata/character.json": cdnCharacters,
        "cdndata/character_text.json": cdnCharacterText,
    })
}
