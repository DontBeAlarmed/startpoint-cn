import { deepFreeze } from "../deep-freeze"
import type {
    NestedOrderedMapTextRows,
    OrderedMapTextRow,
} from "../sync/ordered-map"
import type { Gacha, GachaPoolItem } from "../../lib/types/gacha"
import { parseCsvLine } from "./csv"

const GACHA_PATH = "master/gacha/gacha.orderedmap"
const GACHA_CAMPAIGN_PATH = "master/gacha/gacha_campaign.orderedmap"
const GACHA_FEATURE_CONTENT_PATH = "master/gacha/gacha_feature_content.orderedmap"
const GACHA_ODDS_PREFIX = "master/gacha_odds/"

const GACHA_COLUMN_COUNT = 47
const GACHA_CAMPAIGN_COLUMN_COUNT = 8
const GACHA_FEATURE_CONTENT_COLUMN_COUNT = 9

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
        ? readonly DeepReadonly<U>[]
        : T extends object
            ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T

type RuntimeGacha = Gacha & { readonly name: string }
type ReadonlyRuntimeGachas = Readonly<Record<string, DeepReadonly<RuntimeGacha>>>
type ReadonlyRawRows = Readonly<Record<string, readonly (readonly string[])[]>>
type ReadonlyNestedRawRows = Readonly<Record<string, ReadonlyRawRows>>

export interface GachaSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
    readNested(logicalPath: string): Promise<readonly NestedOrderedMapTextRows[]>
}

export interface GachaConversionOutput {
    readonly "gacha.json": ReadonlyRuntimeGachas
    readonly "gacha_campaign.json": Readonly<Record<string, number>>
    readonly "cdndata/gacha.json": ReadonlyRawRows
    readonly "cdndata/gacha_feature_content.json": ReadonlyNestedRawRows
}

interface RarityOddsEntry {
    readonly rarity: number
    readonly weight: number
}

interface CharacterOddsEntry {
    readonly characterId: number
    readonly rarity: number
    readonly weight: number
    readonly oddsUp: boolean
    readonly isLimited: boolean
    readonly isExchangeable: boolean
    readonly trialReadingForced: boolean
}

interface EquipmentOddsEntry {
    readonly equipmentId: number
    readonly rarity: number
    readonly weight: number
    readonly oddsUp: boolean
    readonly isLimited: boolean
    readonly isExchangeable: boolean
}

interface OddsTable<T> {
    readonly id: string
    readonly entries: readonly T[]
}

type OddsKind = "rarity" | "character" | "equipment"
type GachaRowEntry = readonly [string, string[]]

function invalidGacha(reason: string): never {
    throw new Error(`invalid gacha content: ${reason}`)
}

function compareCanonicalIds(left: string, right: string): number {
    const lengthDifference = left.length - right.length
    if (lengthDifference !== 0) return lengthDifference
    return left < right ? -1 : left > right ? 1 : 0
}

function requireCanonicalId(value: string, subject: string): void {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
        invalidGacha(`${subject} must be a canonical positive integer: ${value}`)
    }
}

function requireRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): GachaRowEntry[] {
    const seen = new Set<string>()
    return [...rows]
        .sort((left, right) => compareCanonicalIds(left.key, right.key))
        .map(row => {
            requireCanonicalId(row.key, `${tableName} key`)
            if (seen.has(row.key)) invalidGacha(`${tableName} has duplicate key: ${row.key}`)
            seen.add(row.key)
            const fields = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidGacha)
            if (fields.length !== columnCount) {
                invalidGacha(
                    `${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`,
                )
            }
            return [row.key, fields] as const
        })
}

function parseStrictInteger(value: string, fieldName: string, source: string): number {
    if (!INTEGER_PATTERN.test(value)) {
        invalidGacha(`${fieldName} must be an integer in ${source}: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalidGacha(`${fieldName} must be a safe integer in ${source}: ${value}`)
    }
    return parsed
}

function parseStrictBoolean(value: string, fieldName: string, source: string): boolean {
    if (value === "true") return true
    if (value === "false") return false
    return invalidGacha(`${fieldName} must be a boolean in ${source}: ${value}`)
}

function parseRarityOdds(rows: readonly OrderedMapTextRow[], oddsId: string): RarityOddsEntry[] {
    return rows.map(row => {
        const source = `${oddsId}[${row.key}]`
        const fields = parseCsvLine(row.text, source, invalidGacha)
        if (fields.length !== 2) invalidGacha(`rarity odds row must have 2 columns in ${source}`)
        return {
            rarity: parseStrictInteger(fields[0], "rarity", source),
            weight: parseStrictInteger(fields[1], "weight", source),
        }
    })
}

function parseCharacterOdds(
    rows: readonly OrderedMapTextRow[],
    oddsId: string,
): CharacterOddsEntry[] {
    return rows.map(row => {
        const source = `${oddsId}[${row.key}]`
        const fields = parseCsvLine(row.text, source, invalidGacha)
        if (fields.length !== 7) invalidGacha(`character odds row must have 7 columns in ${source}`)
        return {
            characterId: parseStrictInteger(fields[0], "characterId", source),
            rarity: parseStrictInteger(fields[1], "rarity", source),
            weight: parseStrictInteger(fields[2], "weight", source),
            oddsUp: parseStrictBoolean(fields[3], "oddsUp", source),
            isLimited: parseStrictBoolean(fields[4], "isLimited", source),
            isExchangeable: parseStrictBoolean(fields[5], "isExchangeable", source),
            trialReadingForced: parseStrictBoolean(fields[6], "trialReadingForced", source),
        }
    })
}

function parseEquipmentOdds(
    rows: readonly OrderedMapTextRow[],
    oddsId: string,
): EquipmentOddsEntry[] {
    return rows.map(row => {
        const source = `${oddsId}[${row.key}]`
        const fields = parseCsvLine(row.text, source, invalidGacha)
        if (fields.length !== 6) invalidGacha(`equipment odds row must have 6 columns in ${source}`)
        return {
            equipmentId: parseStrictInteger(fields[0], "equipmentId", source),
            rarity: parseStrictInteger(fields[1], "rarity", source),
            weight: parseStrictInteger(fields[2], "weight", source),
            oddsUp: parseStrictBoolean(fields[3], "oddsUp", source),
            isLimited: parseStrictBoolean(fields[4], "isLimited", source),
            isExchangeable: parseStrictBoolean(fields[5], "isExchangeable", source),
        }
    })
}

function cleanOptionalId(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const text = value.trim()
    return text && text !== "(None)" ? text : undefined
}

function oddsPath(oddsId: string): string {
    return `${GACHA_ODDS_PREFIX}${oddsId}.orderedmap`
}

async function readOddsTable<T>(
    reader: GachaSourceReader,
    oddsId: string,
    kind: OddsKind,
    parse: (rows: readonly OrderedMapTextRow[], id: string) => T[],
): Promise<OddsTable<T>> {
    let outerRows: readonly NestedOrderedMapTextRows[]
    const logicalPath = oddsPath(oddsId)
    try {
        outerRows = await reader.readNested(logicalPath)
    } catch (error) {
        const wrapped = new Error(
            `referenced ${kind} odds ${oddsId} at ${logicalPath} is missing or unreadable`,
        )
        Object.defineProperty(wrapped, "cause", {
            configurable: true,
            value: error,
            writable: true,
        })
        throw wrapped
    }
    if (outerRows.length !== 1) {
        invalidGacha(`referenced ${kind} odds ${oddsId} must contain exactly one outer key`)
    }
    if (outerRows[0].key !== oddsId) {
        invalidGacha(
            `referenced ${kind} odds outer key must be ${oddsId}, got ${outerRows[0].key}`,
        )
    }
    return { id: oddsId, entries: parse(outerRows[0].rows, oddsId) }
}

async function readOddsGroup<T>(
    reader: GachaSourceReader,
    ids: ReadonlySet<string>,
    kind: OddsKind,
    parse: (rows: readonly OrderedMapTextRow[], id: string) => T[],
): Promise<Readonly<Record<string, OddsTable<T>>>> {
    const entries: Array<readonly [string, OddsTable<T>]> = []
    for (const oddsId of [...ids].sort()) {
        entries.push([oddsId, await readOddsTable(reader, oddsId, kind, parse)])
    }
    return Object.fromEntries(entries)
}

function collectOddsIds(gachaRows: readonly GachaRowEntry[]): {
    rarity: ReadonlySet<string>
    character: ReadonlySet<string>
    equipment: ReadonlySet<string>
} {
    const rarity = new Set<string>()
    const character = new Set<string>()
    const equipment = new Set<string>()
    for (const [gachaId, row] of gachaRows) {
        const rarityOddsId = cleanOptionalId(row[11])
        if (!rarityOddsId) invalidGacha(`gacha[${gachaId}].rarityOddsId must not be blank`)
        rarity.add(rarityOddsId)

        if (row[13] !== "0" && row[13] !== "1") {
            invalidGacha(`gacha[${gachaId}].prizeKind must be 0 or 1`)
        }
        const target = row[13] === "1" ? equipment : character
        const columns = row[13] === "1" ? [22, 23, 24] : [14, 15, 16]
        for (const column of columns) {
            const oddsId = cleanOptionalId(row[column])
            if (oddsId) target.add(oddsId)
        }
    }
    return { rarity, character, equipment }
}

function parseInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10)
    return Number.isFinite(parsed) ? parsed : fallback
}

function parseOptionalInteger(value: string | undefined): number | undefined {
    const text = cleanOptionalId(value)
    if (!text) return undefined
    const parsed = Number.parseInt(text, 10)
    return Number.isFinite(parsed) ? parsed : undefined
}

function parseOptionalBoolean(value: string | undefined, fallback = false): boolean {
    const text = cleanOptionalId(value)?.toLowerCase()
    if (!text) return fallback
    if (text === "true") return true
    if (text === "false") return false
    return fallback
}

function round2(value: number): number {
    return Math.round(value * 100) / 100
}

function normalizeWeightsToThousand(
    weights: readonly number[],
    suppliedTotal: number | null = null,
): number[] {
    const total = suppliedTotal ?? weights.reduce((sum, weight) => sum + weight, 0)
    if (total <= 0) return weights.map(() => 0)

    const exact = weights.map(weight => (weight / total) * 1000)
    const normalized = exact.map(weight => Math.floor(weight))
    let remainder = 1000 - normalized.reduce((sum, weight) => sum + weight, 0)
    const order = exact
        .map((weight, index) => ({ index, fraction: weight - Math.floor(weight) }))
        .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    for (let index = 0; index < order.length && remainder > 0; index += 1) {
        normalized[order[index].index] += 1
        remainder -= 1
    }
    return normalized
}

function buildRankRates(
    rarityOdds: OddsTable<RarityOddsEntry> | undefined,
    guaranteeRarity: number,
): { normal: number[]; multiGuarantee: number[] } {
    if (!rarityOdds) invalidGacha("missing rarity odds table")
    const raw = new Map(rarityOdds.entries.map(entry => [entry.rarity, entry.weight]))
    const totalWeight = rarityOdds.entries.reduce((sum, entry) => sum + entry.weight, 0)
    const normalWeights = [5, 4, 3].map(rarity => raw.get(rarity) || 0)
    const guaranteeWeights = [5, 4].map(rarity => {
        let weight = raw.get(rarity) || 0
        if (rarity < guaranteeRarity) weight = 0
        if (rarity === guaranteeRarity) {
            for (let lower = 1; lower < guaranteeRarity; lower += 1) {
                weight += raw.get(lower) || 0
            }
        }
        return weight
    })
    return {
        normal: normalizeWeightsToThousand(normalWeights, totalWeight),
        multiGuarantee: normalizeWeightsToThousand(guaranteeWeights, totalWeight),
    }
}

function normalizePoolEntries<T extends CharacterOddsEntry | EquipmentOddsEntry>(
    entries: readonly T[],
    idField: "characterId" | "equipmentId",
): GachaPoolItem[] {
    const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)
    return entries.map(entry => {
        const id = idField === "characterId"
            ? (entry as CharacterOddsEntry).characterId
            : (entry as EquipmentOddsEntry).equipmentId
        const item: GachaPoolItem = {
            id,
            rank: entry.rarity,
            odds: entry.weight,
            isRateUp: entry.oddsUp,
            isLimited: entry.isLimited,
            isExchangeable: entry.isExchangeable,
            rarity: totalWeight > 0 ? round2((entry.weight / totalWeight) * 1000) : 0,
        }
        if ("trialReadingForced" in entry) {
            item.trialReadingForced = entry.trialReadingForced
        }
        return item
    })
}

function buildPoolForOddsIds<T extends CharacterOddsEntry | EquipmentOddsEntry>(
    oddsTables: Readonly<Record<string, OddsTable<T>>>,
    mapping: Readonly<Record<string, string | undefined>>,
    idField: "characterId" | "equipmentId",
): Record<string, GachaPoolItem[]> {
    const pool: Record<string, GachaPoolItem[]> = {}
    for (const [poolKey, rawOddsId] of Object.entries(mapping)) {
        const oddsId = cleanOptionalId(rawOddsId)
        if (!oddsId) continue
        const odds = oddsTables[oddsId]
        if (!odds) invalidGacha(`referenced odds table was not loaded: ${oddsId}`)
        pool[poolKey] = normalizePoolEntries(odds.entries, idField)
    }
    return pool
}

function buildBanner(
    gachaId: string,
    row: string[],
    rarityOdds: Readonly<Record<string, OddsTable<RarityOddsEntry>>>,
    characterOdds: Readonly<Record<string, OddsTable<CharacterOddsEntry>>>,
    equipmentOdds: Readonly<Record<string, OddsTable<EquipmentOddsEntry>>>,
): RuntimeGacha {
    const isEquipment = row[13] === "1"
    const name = String(row[1] || `Gacha ${gachaId}`)
    const pageKind = parseInteger(row[4], 0)
    const guaranteeRarity = parseInteger(row[10], 4)
    const rarityOddsId = cleanOptionalId(row[11]) as string
    const rankRates = buildRankRates(rarityOdds[rarityOddsId], guaranteeRarity)
    const singleCost = parseInteger(row[5], isEquipment ? 75 : 150)
    const multiCost = parseInteger(row[6], isEquipment ? 750 : 1500)
    const discountCost = parseInteger(row[7], isEquipment ? 25 : 50)
    const tenTimesPerAccountCost = parseOptionalInteger(row[8])
    const onceTicketItemId = parseOptionalInteger(row[27])
    const tenTicketItemId = parseOptionalInteger(row[28])
    const startDate = String(row[29] || "2000-01-01 00:00:00")
    const endDate = String(row[30] || "2099-01-01 00:00:00")

    if (isEquipment) {
        const equipmentMovieProbabilityId = cleanOptionalId(row[25])
        return {
            type: 1,
            paymentType: 0,
            pageKind,
            singleCost,
            multiCost,
            discountCost,
            ...(tenTimesPerAccountCost ? { tenTimesPerAccountCost } : {}),
            ...(onceTicketItemId ? { onceTicketItemId } : {}),
            ...(tenTicketItemId ? { tenTicketItemId } : {}),
            wildcardTicketAvailable: parseOptionalBoolean(row[26]),
            rarityOddsId,
            guaranteeRarity,
            rankRates,
            ...(equipmentMovieProbabilityId ? { equipmentMovieProbabilityId } : {}),
            startDate,
            endDate,
            name,
            pool: buildPoolForOddsIds(
                equipmentOdds,
                { "1": row[24], "2": row[23], "3": row[22] },
                "equipmentId",
            ),
        } as RuntimeGacha
    }

    return {
        type: 0,
        paymentType: 0,
        pageKind,
        singleCost,
        multiCost,
        discountCost,
        ...(tenTimesPerAccountCost ? { tenTimesPerAccountCost } : {}),
        ...(onceTicketItemId ? { onceTicketItemId } : {}),
        ...(tenTicketItemId ? { tenTicketItemId } : {}),
        wildcardTicketAvailable: parseOptionalBoolean(row[20]),
        rarityOddsId,
        guaranteeRarity,
        rankRates,
        movieName: String(row[17] || "normal"),
        guaranteeMovieName: String(row[18] || "normal_guarantee"),
        toUseOddsUpAsTrialReading: parseOptionalBoolean(row[19]),
        canBeStartDashExchange: parseOptionalBoolean(row[21]),
        startDate,
        endDate,
        name,
        pool: buildPoolForOddsIds(
            characterOdds,
            { "1": row[16], "2": row[15], "3": row[14] },
            "characterId",
        ),
    } as RuntimeGacha
}

function buildCampaigns(rows: readonly OrderedMapTextRow[]): Record<string, number> {
    const mappings = new Map<string, number>()
    for (const [campaignIdText, fields] of requireRows(
        rows,
        "gacha_campaign",
        GACHA_CAMPAIGN_COLUMN_COUNT,
    )) {
        const campaignId = parseStrictInteger(campaignIdText, "campaignId", "gacha_campaign")
        const gachaIds = fields[5].split(",")
        if (gachaIds.length === 1 && gachaIds[0] === "") {
            invalidGacha(`gacha_campaign[${campaignIdText}].gachaIds must not be empty`)
        }
        for (const gachaIdText of gachaIds) {
            const gachaId = parseStrictInteger(
                gachaIdText,
                "gachaId",
                `gacha_campaign[${campaignIdText}]`,
            )
            const key = String(gachaId)
            mappings.set(key, campaignId)
        }
    }
    return Object.fromEntries([...mappings].sort((left, right) => (
        compareCanonicalIds(left[0], right[0])
    )))
}

function buildFeatureContent(
    outerRows: readonly NestedOrderedMapTextRows[],
): Record<string, Record<string, string[][]>> {
    const output: Record<string, Record<string, string[][]>> = {}
    const seen = new Set<string>()
    for (const outer of [...outerRows].sort((left, right) => (
        compareCanonicalIds(left.key, right.key)
    ))) {
        requireCanonicalId(outer.key, "gacha_feature_content outer key")
        if (seen.has(outer.key)) {
            invalidGacha(`gacha_feature_content has duplicate outer key: ${outer.key}`)
        }
        seen.add(outer.key)
        output[outer.key] = Object.fromEntries(requireRows(
            outer.rows,
            `gacha_feature_content[${outer.key}]`,
            GACHA_FEATURE_CONTENT_COLUMN_COUNT,
        ).map(([key, fields]) => [key, [fields]]))
    }
    return output
}

export async function convertGachas(reader: GachaSourceReader): Promise<GachaConversionOutput> {
    const [rawGachaRows, campaignRows, featureRows] = await Promise.all([
        reader.read(GACHA_PATH),
        reader.read(GACHA_CAMPAIGN_PATH),
        reader.readNested(GACHA_FEATURE_CONTENT_PATH),
    ])
    const gachaRows = requireRows(rawGachaRows, "gacha", GACHA_COLUMN_COUNT)
    const ids = collectOddsIds(gachaRows)
    const [rarityOdds, characterOdds, equipmentOdds] = await Promise.all([
        readOddsGroup(reader, ids.rarity, "rarity", parseRarityOdds),
        readOddsGroup(reader, ids.character, "character", parseCharacterOdds),
        readOddsGroup(reader, ids.equipment, "equipment", parseEquipmentOdds),
    ])

    const gachas: Record<string, RuntimeGacha> = {}
    const cdnGachas: Record<string, string[][]> = {}
    for (const [gachaId, fields] of gachaRows) {
        gachas[gachaId] = buildBanner(
            gachaId,
            fields,
            rarityOdds,
            characterOdds,
            equipmentOdds,
        )
        cdnGachas[gachaId] = [fields]
    }

    return deepFreeze({
        "gacha.json": gachas,
        "gacha_campaign.json": buildCampaigns(campaignRows),
        "cdndata/gacha.json": cdnGachas,
        "cdndata/gacha_feature_content.json": buildFeatureContent(featureRows),
    })
}
