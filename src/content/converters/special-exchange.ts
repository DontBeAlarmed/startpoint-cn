import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import {
    gameCalendarSupportedYearRange,
} from "./context"
import { parseCsvLine } from "./csv"
import { createGameCalendarPolicy } from "../../time/game-calendar"

export const SPECIAL_EXCHANGE_CAMPAIGN_PATH =
    "master/campaign/special_exchange/special_exchange_campaign.orderedmap"
export const SPECIAL_EXCHANGE_CAMPAIGN_CHARACTER_PATH =
    "master/campaign/special_exchange/special_exchange_campaign_character.orderedmap"
export const SPECIAL_EXCHANGE_CAMPAIGN_EQUIPMENT_PATH =
    "master/campaign/special_exchange/special_exchange_campaign_equipment.orderedmap"

// Column count follows the client's SpecialExchangeCampaignValues.as
// constructor (positional array). The character/equipment lineups are
// single-column id lists stored as newline-separated text rows.
const CAMPAIGN_COLUMN_COUNT = 17

export type SpecialExchangeCampaignKind = 0 | 1 // 0 = character, 1 = equipment

export interface SpecialExchangeCampaignDefinition {
    readonly campaignId: number
    readonly stringId: string
    readonly name: string
    readonly scene: number
    readonly type: SpecialExchangeCampaignKind
    readonly campaignStartTimeMs: number
    readonly campaignEndTimeMs: number
    readonly exchangeStartTimeMs: number
    readonly exchangeEndTimeMs: number
    readonly headerBackgroundImage: string
    readonly ticketItemId: number
    readonly obtainSource: 0 | 1
    /** Paid vmoney price; null means the ticket is granted, never sold. */
    readonly price: number | null
    readonly productThumbnail: string
    readonly productName: string
    readonly howToPlayTitleId: string
    readonly howToPlayRichText: string
    readonly reasonId: number
}

export interface SpecialExchangeSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface SpecialExchangeConversionOutput {
    readonly "special_exchange_campaign.json":
        Readonly<Record<string, SpecialExchangeCampaignDefinition>>
    readonly "special_exchange_campaign_character.json":
        Readonly<Record<string, readonly number[]>>
    readonly "special_exchange_campaign_equipment.json":
        Readonly<Record<string, readonly number[]>>
}

// The client parses every special-exchange timestamp with
// ParseTools.parseJstDataToUtcTime, which is hard-wired to UTC+9 regardless of
// the server game calendar, so conversion must use the same fixed JST offset.
const JST_CALENDAR = createGameCalendarPolicy(540)

function invalid(reason: string): never {
    throw new Error(`invalid special exchange content: ${reason}`)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

const CAMPAIGN_KEY_PATTERN = /^[1-9]\d*$/
const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/

function parseInteger(
    value: string,
    subject: string,
    pattern: RegExp,
): number {
    if (!pattern.test(value)) invalid(`${subject} must be an integer: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalid(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parseJstTimestamp(value: string, subject: string): number {
    let parsed: number
    try {
        parsed = JST_CALENDAR.parseMasterTimestamp(value)
    } catch {
        return invalid(`${subject} must be a valid JST date-time: ${value}`)
    }
    const range = gameCalendarSupportedYearRange(JST_CALENDAR)
    if (parsed < range.minEpochMs || parsed >= range.exclusiveMaxEpochMs) {
        invalid(`${subject} is outside the supported JST date-time range: ${value}`)
    }
    return parsed
}

/**
 * Validates the converted runtime campaign table so release readers and the
 * runtime accessor share converter invariants.
 */
export function validateSpecialExchangeCampaignTable(
    raw: unknown,
): Readonly<Record<string, SpecialExchangeCampaignDefinition>> {
    if (!isRecord(raw)) invalid("campaign catalog root must be an object")
    const table = raw as Readonly<Record<string, unknown>>
    if (Object.keys(table).length === 0) invalid("campaign catalog must not be empty")
    for (const [idText, rawEntry] of Object.entries(table)) {
        if (!CAMPAIGN_KEY_PATTERN.test(idText)) {
            invalid(`campaign key must be a canonical positive integer: ${idText}`)
        }
        if (!isRecord(rawEntry)) invalid(`campaign ${idText} must be an object`)
        const entry = rawEntry as Readonly<Record<string, unknown>>
        if (entry.campaignId !== Number(idText)) {
            invalid(`campaign ${idText} id does not match key`)
        }
        if (typeof entry.stringId !== "string" || entry.stringId === "") {
            invalid(`campaign ${idText} stringId is invalid`)
        }
        if (typeof entry.name !== "string" || entry.name === "") {
            invalid(`campaign ${idText} name is invalid`)
        }
        if (entry.scene !== 0 && entry.scene !== 1) {
            invalid(`campaign ${idText} scene must be 0 or 1`)
        }
        if (entry.type !== 0 && entry.type !== 1) {
            invalid(`campaign ${idText} type must be 0 or 1`)
        }
        if (typeof entry.campaignStartTimeMs !== "number"
            || typeof entry.campaignEndTimeMs !== "number"
            || entry.campaignEndTimeMs < entry.campaignStartTimeMs) {
            invalid(`campaign ${idText} campaign period is invalid`)
        }
        if (typeof entry.exchangeStartTimeMs !== "number"
            || typeof entry.exchangeEndTimeMs !== "number"
            || entry.exchangeEndTimeMs < entry.exchangeStartTimeMs) {
            invalid(`campaign ${idText} exchange period is invalid`)
        }
        if (typeof entry.headerBackgroundImage !== "string"
            || entry.headerBackgroundImage === "") {
            invalid(`campaign ${idText} headerBackgroundImage is invalid`)
        }
        if (typeof entry.ticketItemId !== "number"
            || !Number.isSafeInteger(entry.ticketItemId)
            || entry.ticketItemId <= 0) {
            invalid(`campaign ${idText} ticketItemId must be positive`)
        }
        if (entry.obtainSource !== 0 && entry.obtainSource !== 1) {
            invalid(`campaign ${idText} obtainSource must be 0 or 1`)
        }
        if (entry.price !== null
            && (typeof entry.price !== "number"
                || !Number.isSafeInteger(entry.price)
                || entry.price <= 0)) {
            invalid(`campaign ${idText} price must be null or positive`)
        }
        if (typeof entry.productThumbnail !== "string"
            || entry.productThumbnail === "") {
            invalid(`campaign ${idText} productThumbnail is invalid`)
        }
        if (typeof entry.productName !== "string" || entry.productName === "") {
            invalid(`campaign ${idText} productName is invalid`)
        }
        if (typeof entry.howToPlayTitleId !== "string"
            || entry.howToPlayTitleId === "") {
            invalid(`campaign ${idText} howToPlayTitleId is invalid`)
        }
        if (typeof entry.howToPlayRichText !== "string"
            || entry.howToPlayRichText === "") {
            invalid(`campaign ${idText} howToPlayRichText is invalid`)
        }
        if (typeof entry.reasonId !== "number"
            || !Number.isSafeInteger(entry.reasonId)
            || entry.reasonId < 0) {
            invalid(`campaign ${idText} reasonId must be non-negative`)
        }
    }
    return deepFreeze(table as Readonly<Record<string, SpecialExchangeCampaignDefinition>>)
}

/**
 * Validates a converted sub table (character or equipment exchange lineups).
 * `campaigns` cross-checks that every lineup belongs to a known campaign.
 */
export function validateSpecialExchangeSubTable(
    raw: unknown,
    tableName: string,
    campaigns: Readonly<Record<string, unknown>>,
): Readonly<Record<string, readonly number[]>> {
    if (!isRecord(raw)) invalid(`${tableName} root must be an object`)
    const table = raw as Readonly<Record<string, unknown>>
    for (const [idText, rawIds] of Object.entries(table)) {
        if (!CAMPAIGN_KEY_PATTERN.test(idText)) {
            invalid(`${tableName} key must be a canonical positive integer: ${idText}`)
        }
        if (campaigns[idText] === undefined) {
            invalid(`${tableName} references unknown campaign: ${idText}`)
        }
        if (!Array.isArray(rawIds)) invalid(`${tableName} ${idText} must be an array`)
        const ids = rawIds as unknown[]
        if (ids.length === 0) invalid(`${tableName} ${idText} must not be empty`)
        for (const rawId of ids) {
            if (typeof rawId !== "number"
                || !Number.isSafeInteger(rawId)
                || rawId <= 0) {
                invalid(`${tableName} ${idText} entries must be positive integers`)
            }
        }
        if (new Set(ids).size !== ids.length) {
            invalid(`${tableName} ${idText} contains duplicate ids`)
        }
    }
    return deepFreeze(table as Readonly<Record<string, readonly number[]>>)
}

interface ParsedCampaignRow {
    readonly campaignId: number
    readonly type: SpecialExchangeCampaignKind
    readonly definition: SpecialExchangeCampaignDefinition
}

function parseCampaignRow(key: string, fields: readonly string[]): ParsedCampaignRow {
    const subject = `special_exchange_campaign[${key}]`
    if (fields.length !== CAMPAIGN_COLUMN_COUNT) {
        invalid(`${subject} must have ${CAMPAIGN_COLUMN_COUNT} columns, got ${fields.length}`)
    }
    const type = parseInteger(fields[3], `${subject}.type`, INTEGER_PATTERN)
    if (type !== 0 && type !== 1) invalid(`${subject}.type must be 0 or 1`)
    const obtainSource = parseInteger(fields[10], `${subject}.obtainSource`, INTEGER_PATTERN)
    if (obtainSource !== 0 && obtainSource !== 1) {
        invalid(`${subject}.obtainSource must be 0 or 1`)
    }
    const campaignStartTimeMs = parseJstTimestamp(fields[4], `${subject}.campaignStartTime`)
    const campaignEndTimeMs = parseJstTimestamp(fields[5], `${subject}.campaignEndTime`)
    const exchangeStartTimeMs = parseJstTimestamp(fields[6], `${subject}.exchangeStartTime`)
    const exchangeEndTimeMs = parseJstTimestamp(fields[7], `${subject}.exchangeEndTime`)
    if (campaignEndTimeMs < campaignStartTimeMs) {
        invalid(`${subject} has an inverted campaign period`)
    }
    if (exchangeEndTimeMs < exchangeStartTimeMs) {
        invalid(`${subject} has an inverted exchange period`)
    }
    const priceText = fields[11]
    const price = priceText === "(None)"
        ? null
        : parseInteger(priceText, `${subject}.price`, NON_NEGATIVE_INTEGER_PATTERN)
    return {
        campaignId: Number(key),
        type,
        definition: {
            campaignId: Number(key),
            stringId: fields[0],
            name: fields[1],
            scene: parseInteger(fields[2], `${subject}.scene`, NON_NEGATIVE_INTEGER_PATTERN),
            type,
            campaignStartTimeMs,
            campaignEndTimeMs,
            exchangeStartTimeMs,
            exchangeEndTimeMs,
            headerBackgroundImage: fields[8],
            ticketItemId: parseInteger(
                fields[9],
                `${subject}.ticketItemId`,
                NON_NEGATIVE_INTEGER_PATTERN,
            ),
            obtainSource,
            price,
            productThumbnail: fields[12],
            productName: fields[13],
            howToPlayTitleId: fields[14],
            howToPlayRichText: fields[15],
            reasonId: parseInteger(fields[16], `${subject}.reasonId`, NON_NEGATIVE_INTEGER_PATTERN),
        },
    }
}

function parseSubTableRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
): Record<string, number[]> {
    const table: Record<string, number[]> = {}
    for (const row of rows) {
        if (!CAMPAIGN_KEY_PATTERN.test(row.key)) {
            invalid(`${tableName} key must be a canonical positive integer: ${row.key}`)
        }
        if (table[row.key] !== undefined) {
            invalid(`${tableName} has duplicate key: ${row.key}`)
        }
        // 行值是换行分隔的 id 列表（二进制源里为压缩文本行，官方 extractor
        // 输出为 {campaignKey: [[id], [id], ...]} 的等价 JSON）。
        const ids = row.text
            .split("\n")
            .map(line => line.trim())
            .filter(line => line !== "")
            .map(line => parseInteger(line, `${tableName}[${row.key}] entry`, NON_NEGATIVE_INTEGER_PATTERN))
        if (ids.length === 0) invalid(`${tableName}[${row.key}] must not be empty`)
        table[row.key] = ids
    }
    return table
}

function requireKindForSubTable(
    subTable: Readonly<Record<string, readonly number[]>>,
    campaigns: Readonly<Record<string, ParsedCampaignRow>>,
    tableName: string,
    expectedType: SpecialExchangeCampaignKind,
): void {
    for (const [idText, ids] of Object.entries(subTable)) {
        const campaign = campaigns[idText]
        if (campaign === undefined) {
            invalid(`${tableName} references unknown campaign: ${idText}`)
        }
        if (campaign.type !== expectedType) {
            invalid(`${tableName} ${idText} references a campaign of the wrong type`)
        }
        void ids
    }
}

function requireLineupForCampaign(
    campaigns: Readonly<Record<string, ParsedCampaignRow>>,
    subTable: Readonly<Record<string, readonly number[]>>,
    tableName: string,
    expectedType: SpecialExchangeCampaignKind,
): void {
    for (const [idText, campaign] of Object.entries(campaigns)) {
        if (campaign.type !== expectedType) continue
        if (subTable[idText] === undefined) {
            invalid(`campaign ${idText} is missing its ${tableName} lineup`)
        }
    }
}

export async function convertSpecialExchangeTables(
    reader: SpecialExchangeSourceReader,
): Promise<SpecialExchangeConversionOutput> {
    const [campaignRows, characterRows, equipmentRows] = await Promise.all([
        reader.read(SPECIAL_EXCHANGE_CAMPAIGN_PATH),
        reader.read(SPECIAL_EXCHANGE_CAMPAIGN_CHARACTER_PATH),
        reader.read(SPECIAL_EXCHANGE_CAMPAIGN_EQUIPMENT_PATH),
    ])

    const campaigns: Record<string, ParsedCampaignRow> = {}
    for (const row of campaignRows) {
        if (!CAMPAIGN_KEY_PATTERN.test(row.key) || campaigns[row.key] !== undefined) {
            invalid(`campaign key must be a unique positive integer: ${row.key}`)
        }
        campaigns[row.key] = parseCampaignRow(
            row.key,
            parseCsvLine(row.text, `special_exchange_campaign[${row.key}]`, invalid),
        )
    }
    if (Object.keys(campaigns).length === 0) {
        invalid("special_exchange_campaign must not be empty")
    }

    const characterTable = parseSubTableRows(
        characterRows,
        "special_exchange_campaign_character",
    )
    const equipmentTable = parseSubTableRows(
        equipmentRows,
        "special_exchange_campaign_equipment",
    )
    requireKindForSubTable(characterTable, campaigns, "special_exchange_campaign_character", 0)
    requireKindForSubTable(equipmentTable, campaigns, "special_exchange_campaign_equipment", 1)
    requireLineupForCampaign(campaigns, characterTable, "character", 0)
    requireLineupForCampaign(campaigns, equipmentTable, "equipment", 1)

    return deepFreeze({
        "special_exchange_campaign.json": validateSpecialExchangeCampaignTable(
            Object.fromEntries(Object.entries(campaigns).map(
                ([key, parsed]) => [key, parsed.definition],
            )),
        ),
        "special_exchange_campaign_character.json":
            validateSpecialExchangeSubTable(
                characterTable,
                "special_exchange_campaign_character",
                campaigns,
            ),
        "special_exchange_campaign_equipment.json":
            validateSpecialExchangeSubTable(
                equipmentTable,
                "special_exchange_campaign_equipment",
                campaigns,
            ),
    })
}
