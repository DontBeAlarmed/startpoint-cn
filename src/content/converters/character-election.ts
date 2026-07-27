import { deepFreeze } from "../deep-freeze"
import type {
    NestedOrderedMapTextRows,
    OrderedMapTextRow,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const ELECTION_COLUMN_COUNT = 4
const CHARACTER_COLUMN_COUNT = 37
const ENCYCLOPEDIA_COLUMN_COUNT = 40
const CHARACTER_IDENTITY_COLUMN = 27
const ENCYCLOPEDIA_SECRET_COLUMN = 2
const ENCYCLOPEDIA_KIND_COLUMN = 4
const ENCYCLOPEDIA_CHARACTER_COLUMN = 5

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const MASTER_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

export interface ReadonlyCharacterElectionRule {
    readonly stringId: string
    readonly startTime: string
    readonly endTime: string
    readonly keywordIds: readonly number[]
}

export type ReadonlyCharacterElectionTable = Readonly<
    Record<string, ReadonlyCharacterElectionRule>
>

export interface CharacterElectionConversionInput {
    readonly electionRows: readonly OrderedMapTextRow[]
    readonly excludeRows: readonly OrderedMapTextRow[]
    readonly characterRows: readonly OrderedMapTextRow[]
    readonly encyclopediaRows: readonly NestedOrderedMapTextRows[]
}

export interface CharacterElectionConversionOutput {
    readonly "character_election.json": ReadonlyCharacterElectionTable
}

function invalid(reason: string): never {
    throw new Error(`invalid character election content: ${reason}`)
}

function parsePositiveInteger(value: string, subject: string): number {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) invalid(`${subject} must be a positive integer`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalid(`${subject} must be a safe integer`)
    return parsed
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return isLeapYear(year) ? 29 : 28
    return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseMasterTime(value: string, subject: string): number {
    const match = MASTER_TIME_PATTERN.exec(value)
    if (!match) invalid(`${subject} must use YYYY-MM-DD HH:mm:ss`)
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    if (year < 1970 || year > 2200 || month < 1 || month > 12
        || day < 1 || day > daysInMonth(year, month)
        || hour > 23 || minute > 59 || second > 59) {
        invalid(`${subject} is not a valid calendar time`)
    }
    return Date.UTC(year, month - 1, day, hour - 8, minute, second)
}

function parseRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): ReadonlyMap<number, readonly string[]> {
    const parsed = new Map<number, readonly string[]>()
    for (const row of rows) {
        const id = parsePositiveInteger(row.key, `${tableName} key`)
        if (parsed.has(id)) invalid(`${tableName} has duplicate key ${id}`)
        const fields = parseCsvLine(
            row.text,
            `${tableName}[${id}]`,
            reason => invalid(reason),
        )
        if (fields.length !== columnCount) {
            invalid(`${tableName}[${id}] must have ${columnCount} columns, got ${fields.length}`)
        }
        parsed.set(id, fields)
    }
    return parsed
}

function parseExcludes(rows: readonly OrderedMapTextRow[]): ReadonlyMap<number, ReadonlySet<number>> {
    const result = new Map<number, ReadonlySet<number>>()
    for (const row of rows) {
        const electionId = parsePositiveInteger(row.key, "character_election_exclude key")
        if (result.has(electionId)) {
            invalid(`character_election_exclude has duplicate key ${electionId}`)
        }
        const excluded = new Set<number>()
        if (row.text.length > 0) {
            for (const token of row.text.split("\n")) {
                const keywordId = parsePositiveInteger(
                    token,
                    `character_election_exclude[${electionId}] keyword`,
                )
                if (excluded.has(keywordId)) {
                    invalid(`character_election_exclude[${electionId}] has duplicate keyword ${keywordId}`)
                }
                excluded.add(keywordId)
            }
        }
        result.set(electionId, excluded)
    }
    return result
}

function parseCharacterIdentities(
    rows: readonly OrderedMapTextRow[],
): ReadonlyMap<number, number | null> {
    const characters = parseRows(rows, "character", CHARACTER_COLUMN_COUNT)
    return new Map([...characters].map(([characterId, fields]) => {
        const identityToken = fields[CHARACTER_IDENTITY_COLUMN]
        return [
            characterId,
            identityToken === "(None)"
                ? null
                : parsePositiveInteger(identityToken, `character[${characterId}].identity_character_id`),
        ] as const
    }))
}

interface EncyclopediaCandidate {
    readonly keywordId: number
    readonly secret: boolean
    readonly kind: number
    readonly characterId: number | null
}

function parseEncyclopediaCandidates(
    rows: readonly NestedOrderedMapTextRows[],
): readonly EncyclopediaCandidate[] {
    const seen = new Set<number>()
    return rows.map(entry => {
        const keywordId = parsePositiveInteger(entry.key, "encyclopedia key")
        if (seen.has(keywordId)) invalid(`encyclopedia has duplicate key ${keywordId}`)
        seen.add(keywordId)
        const mainRows = entry.rows.filter(row => row.key === "1")
        if (mainRows.length !== 1) {
            invalid(`encyclopedia[${keywordId}] must have exactly one main row`)
        }
        const fields = parseCsvLine(
            mainRows[0].text,
            `encyclopedia[${keywordId}][1]`,
            reason => invalid(reason),
        )
        if (fields.length !== ENCYCLOPEDIA_COLUMN_COUNT) {
            invalid(`encyclopedia[${keywordId}][1] must have ${ENCYCLOPEDIA_COLUMN_COUNT} columns, got ${fields.length}`)
        }
        const multipliedId = parsePositiveInteger(fields[0], `encyclopedia[${keywordId}][1].multiplied_id`)
        if (multipliedId !== keywordId * 100 + 1) {
            invalid(`encyclopedia[${keywordId}][1] has mismatched multiplied_id`)
        }
        const secretToken = fields[ENCYCLOPEDIA_SECRET_COLUMN]
        if (secretToken !== "true" && secretToken !== "false") {
            invalid(`encyclopedia[${keywordId}][1].is_secret must be a boolean`)
        }
        const kind = parsePositiveOrZeroInteger(
            fields[ENCYCLOPEDIA_KIND_COLUMN],
            `encyclopedia[${keywordId}][1].kind`,
        )
        const characterId = kind === 0
            ? parsePositiveInteger(
                fields[ENCYCLOPEDIA_CHARACTER_COLUMN],
                `encyclopedia[${keywordId}][1].character_id`,
            )
            : null
        return { keywordId, secret: secretToken === "true", kind, characterId }
    })
}

function parsePositiveOrZeroInteger(value: string, subject: string): number {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) invalid(`${subject} must be a non-negative integer`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalid(`${subject} must be a safe integer`)
    return parsed
}

export function convertCharacterElections(
    input: CharacterElectionConversionInput,
): CharacterElectionConversionOutput {
    const elections = parseRows(input.electionRows, "election", ELECTION_COLUMN_COUNT)
    const excludes = parseExcludes(input.excludeRows)
    const identities = parseCharacterIdentities(input.characterRows)
    const encyclopedia = parseEncyclopediaCandidates(input.encyclopediaRows)

    if (elections.size === 0) invalid("election must not be empty")
    if (excludes.size !== elections.size
        || [...elections.keys()].some(electionId => !excludes.has(electionId))) {
        invalid("character_election_exclude keys must match election keys")
    }

    const eligibleKeywordIds = encyclopedia.flatMap(candidate => {
        if (candidate.secret) return []
        if (candidate.kind === 2) return [candidate.keywordId]
        if (candidate.kind !== 0 || candidate.characterId === null) return []
        if (!identities.has(candidate.characterId)) {
            invalid(`encyclopedia[${candidate.keywordId}] references missing character ${candidate.characterId}`)
        }
        const identity = identities.get(candidate.characterId)
        return identity === null || identity === candidate.characterId
            ? [candidate.keywordId]
            : []
    })

    const output: Record<string, ReadonlyCharacterElectionRule> = {}
    for (const [electionId, fields] of elections) {
        const [stringId, _headerImage, startTime, endTime] = fields
        if (!/^[A-Za-z0-9_]+$/.test(stringId)) {
            invalid(`election[${electionId}] stringId must be a stable identifier`)
        }
        const start = parseMasterTime(startTime, `election[${electionId}] startTime`)
        const end = parseMasterTime(endTime, `election[${electionId}] endTime`)
        if (start > end) invalid(`election[${electionId}] period is reversed`)
        const excluded = excludes.get(electionId)!
        output[String(electionId)] = {
            stringId,
            startTime,
            endTime,
            keywordIds: eligibleKeywordIds
                .filter(keywordId => !excluded.has(keywordId))
                .sort((left, right) => left - right),
        }
    }
    return deepFreeze({ "character_election.json": output })
}
