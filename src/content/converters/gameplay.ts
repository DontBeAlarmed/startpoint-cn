import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const CARNIVAL_REWARD_PATH =
    "master/quest/event/carnival_event_total_score_reward.orderedmap"
const EQUIPMENT_MOVIE_PATH = "master/gacha/equipment_gacha_movie_probability.orderedmap"
const EX_BOOST_PATH = "master/ex_boost/ex_boost.orderedmap"
const EX_STATUS_PATH = "master/ex_boost/ex_status.orderedmap"
const RAID_EVENT_PATH = "master/quest/event/raid_event.orderedmap"

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const CARNIVAL_REWARD_KINDS = new Set([0, 1, 2, 3, 4, 7])

export interface GameplaySourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface GameplayConversionOutput {
    readonly "carnival_event_total_score_reward.json": Readonly<Record<string, unknown>>
    readonly "equipment_gacha_movie_probability.json": Readonly<Record<string, unknown>>
    readonly "ex_boost.json": Readonly<Record<string, unknown>>
    readonly "ex_status.json": Readonly<Record<string, readonly number[]>>
    readonly "raid_event.json": Readonly<Record<string, unknown>>
}

type ParsedRow = readonly [string, readonly string[]]

function invalidGameplay(reason: string): never {
    throw new Error(`invalid gameplay content: ${reason}`)
}

function compareIds(left: string, right: string): number {
    return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

function parseRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): ParsedRow[] {
    const seen = new Set<string>()
    return [...rows]
        .sort((left, right) => compareIds(left.key, right.key))
        .map(row => {
            if (!POSITIVE_INTEGER_PATTERN.test(row.key)) {
                invalidGameplay(`${tableName} key must be a canonical positive integer: ${row.key}`)
            }
            if (seen.has(row.key)) invalidGameplay(`${tableName} has duplicate key: ${row.key}`)
            seen.add(row.key)
            const fields = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidGameplay)
            if (fields.length !== columnCount) {
                invalidGameplay(
                    `${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`,
                )
            }
            return [row.key, fields] as const
        })
}

function parseInteger(value: string, subject: string): number {
    if (!INTEGER_PATTERN.test(value)) invalidGameplay(`${subject} must be an integer: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidGameplay(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed <= 0) invalidGameplay(`${subject} must be a positive integer: ${value}`)
    return parsed
}

function parseOptionalInteger(value: string, subject: string): number | undefined {
    return value === "" || value === "(None)" ? undefined : parseInteger(value, subject)
}

function parseProbability(value: string, subject: string): number {
    if (value === "" || value.trim() !== value) {
        invalidGameplay(`${subject} must be a probability: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        invalidGameplay(`${subject} must be between 0 and 1: ${value}`)
    }
    return parsed
}

function convertCarnivalRewards(rows: readonly OrderedMapTextRow[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const [id, fields] of parseRows(rows, "carnival_event_total_score_reward", 22)) {
        const rewards: Array<Record<string, number>> = []
        for (let index = 4; index < 22; index += 3) {
            const kind = parseOptionalInteger(
                fields[index],
                `carnival_event_total_score_reward[${id}].reward[${index}].kind`,
            )
            const rewardId = parseOptionalInteger(
                fields[index + 1],
                `carnival_event_total_score_reward[${id}].reward[${index}].id`,
            )
            const amount = parseOptionalInteger(
                fields[index + 2],
                `carnival_event_total_score_reward[${id}].reward[${index}].amount`,
            )
            if (kind === undefined && rewardId === undefined && amount === undefined) continue
            if (kind === undefined || !CARNIVAL_REWARD_KINDS.has(kind)) {
                invalidGameplay(
                    `carnival_event_total_score_reward[${id}].reward[${index}] has an invalid kind`,
                )
            }
            if (amount === undefined || amount <= 0) {
                invalidGameplay(
                    `carnival_event_total_score_reward[${id}].reward[${index}] has an invalid amount`,
                )
            }
            if ((kind === 0 || kind === 1 || kind === 7) && rewardId === undefined) {
                invalidGameplay(
                    `carnival_event_total_score_reward[${id}].reward[${index}] requires an id`,
                )
            }
            rewards.push({
                kind,
                ...(rewardId === undefined ? {} : { id: rewardId }),
                amount,
            })
        }
        if (rewards.length === 0) {
            invalidGameplay(`carnival_event_total_score_reward[${id}] must contain a reward`)
        }
        output[id] = {
            id: Number(id),
            eventId: parsePositiveInteger(
                fields[0],
                `carnival_event_total_score_reward[${id}].eventId`,
            ),
            score: parsePositiveInteger(
                fields[2],
                `carnival_event_total_score_reward[${id}].score`,
            ),
            reasonId: parsePositiveInteger(
                fields[3],
                `carnival_event_total_score_reward[${id}].reasonId`,
            ),
            rewards,
        }
    }
    return output
}

function convertEquipmentMovie(rows: readonly OrderedMapTextRow[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    const names = [
        "probabilityEruption",
        "probabilityTreasureUp3To5",
        "probabilityTreasureUp4To5",
        "probabilityTreasureUp3To4",
        "guaranteeProbabilityTreasureUp3To5",
        "guaranteeProbabilityTreasureUp4To5",
        "guaranteeProbabilityTreasureUp3To4",
    ] as const
    for (const [id, fields] of parseRows(rows, "equipment_gacha_movie_probability", 8)) {
        if (fields[0] === "" || fields[0] === "(None)") {
            invalidGameplay(`equipment_gacha_movie_probability[${id}].stringId must be present`)
        }
        output[id] = {
            stringId: fields[0],
            ...Object.fromEntries(names.map((name, index) => [
                name,
                parseProbability(
                    fields[index + 1],
                    `equipment_gacha_movie_probability[${id}].${name}`,
                ),
            ])),
        }
    }
    return output
}

function convertExBoost(rows: readonly OrderedMapTextRow[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const [id, fields] of parseRows(rows, "ex_boost", 3)) {
        const tierMatch = /_r([345])$/.exec(fields[1])
        if (tierMatch === null) invalidGameplay(`ex_boost[${id}].name has no tier suffix`)
        const elements = fields[2].split(",").map(value => value.trim())
        if (elements.some(value => !INTEGER_PATTERN.test(value))) {
            invalidGameplay(`ex_boost[${id}].elements must be comma-separated integers`)
        }
        const uniqueElements = new Set(elements.map(Number))
        if (uniqueElements.size !== elements.length || [...uniqueElements].some(value => value < 0 || value > 5)) {
            invalidGameplay(`ex_boost[${id}].elements must contain unique values from 0 to 5`)
        }
        output[id] = {
            tier: Number(tierMatch[1]) - 2,
            count: parsePositiveInteger(fields[0], `ex_boost[${id}].count`),
            ...(elements.length === 1 ? { element: Number(elements[0]) } : {}),
        }
    }
    return output
}

function convertExStatus(rows: readonly OrderedMapTextRow[]): Record<string, number[]> {
    const output: Record<string, number[]> = { "1": [], "2": [], "3": [] }
    for (const [id, fields] of parseRows(rows, "ex_status", 4)) {
        const rarity = parseInteger(fields[3], `ex_status[${id}].rarity`)
        if (rarity < 3 || rarity > 5) invalidGameplay(`ex_status[${id}].rarity must be 3, 4, or 5`)
        output[String(rarity - 2)].push(Number(id))
    }
    return output
}

function convertRaidEvents(rows: readonly OrderedMapTextRow[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const [id, fields] of parseRows(rows, "raid_event", 25)) {
        output[id] = {
            requiredKillCount: parsePositiveInteger(
                fields[17],
                `raid_event[${id}].requiredKillCount`,
            ),
        }
    }
    return output
}

export async function convertGameplayTables(
    reader: GameplaySourceReader,
): Promise<GameplayConversionOutput> {
    const [carnivalRows, equipmentMovieRows, exBoostRows, exStatusRows, raidEventRows] =
        await Promise.all([
            reader.read(CARNIVAL_REWARD_PATH),
            reader.read(EQUIPMENT_MOVIE_PATH),
            reader.read(EX_BOOST_PATH),
            reader.read(EX_STATUS_PATH),
            reader.read(RAID_EVENT_PATH),
        ])
    return deepFreeze({
        "carnival_event_total_score_reward.json": convertCarnivalRewards(carnivalRows),
        "equipment_gacha_movie_probability.json": convertEquipmentMovie(equipmentMovieRows),
        "ex_boost.json": convertExBoost(exBoostRows),
        "ex_status.json": convertExStatus(exStatusRows),
        "raid_event.json": convertRaidEvents(raidEventRows),
    })
}
