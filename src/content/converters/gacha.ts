import { deepFreeze } from "../deep-freeze"
import { mapWithConcurrency } from "../concurrency"
import type {
    NestedOrderedMapTextRows,
    OrderedMapTextRow,
} from "../sync/ordered-map"
import type { GachaCampaignDefinition, GachaExchangeRates, GachaPoolItem, GachaPools, GachaRuntimeBanner, GachaRuntimeBanners, GachaRuntimePage, StarsGachaCampaignDefinition } from "../../lib/types/gacha"
import { parseCsvLine } from "./csv"

const GACHA_PATH = "master/gacha/gacha.orderedmap"
const GACHA_CAMPAIGN_PATH = "master/gacha/gacha_campaign.orderedmap"
const GACHA_FEATURE_CONTENT_PATH = "master/gacha/gacha_feature_content.orderedmap"
const STARS_GACHA_CAMPAIGN_PATH = "master/campaign/stars_gacha/stars_gacha_campaign.orderedmap"
const CHARACTER_EXCHANGE_RATE_PATH = "master/gacha/exchange_point/character_exchange_rate.orderedmap"
const EQUIPMENT_EXCHANGE_RATE_PATH = "master/gacha/exchange_point/equipment_exchange_rate.orderedmap"
const GACHA_ODDS_PREFIX = "master/gacha_odds/"

const GACHA_COLUMN_COUNT = 47
const GACHA_CAMPAIGN_COLUMN_COUNT = 8
const GACHA_FEATURE_CONTENT_COLUMN_COUNT = 9

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

type ReadonlyRawRows = Readonly<Record<string, readonly (readonly string[])[]>>
type ReadonlyNestedRawRows = Readonly<Record<string, ReadonlyRawRows>>

export interface GachaSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
    readNested(logicalPath: string): Promise<readonly NestedOrderedMapTextRows[]>
}

export interface GachaConversionOutput {
    readonly "gacha.json": GachaRuntimeBanners
    readonly "gacha_campaign_definitions.json": Readonly<Record<string, GachaCampaignDefinition>>
    readonly "stars_gacha_campaign.json": Readonly<Record<string, StarsGachaCampaignDefinition>>
    readonly "gacha_exchange_rate.json": Readonly<GachaExchangeRates>
    readonly "gacha_pool.json": GachaPools
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

function parsePositiveInteger(value: string, fieldName: string, source: string): number {
    const parsed = parseStrictInteger(value, fieldName, source)
    if (parsed <= 0) invalidGacha(`${fieldName} must be positive in ${source}: ${value}`)
    return parsed
}

// Official odds tables legitimately carry weight 0 (a tier or entry that can
// never drop, e.g. rare_rarity pools without rarity-2 drops), so weights are
// only required to be non-negative; permille math already maps 0 to 0‰.
function parseNonNegativeWeight(value: string, source: string): number {
    const parsed = parseStrictInteger(value, "weight", source)
    if (parsed < 0) invalidGacha(`weight must be non-negative in ${source}: ${value}`)
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
            rarity: parsePositiveInteger(fields[0], "rarity", source),
            weight: parseNonNegativeWeight(fields[1], source),
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
            characterId: parsePositiveInteger(fields[0], "characterId", source),
            rarity: parsePositiveInteger(fields[1], "rarity", source),
            weight: parseNonNegativeWeight(fields[2], source),
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
            equipmentId: parsePositiveInteger(fields[0], "equipmentId", source),
            rarity: parsePositiveInteger(fields[1], "rarity", source),
            weight: parseNonNegativeWeight(fields[2], source),
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
    const entries = await mapWithConcurrency(
        [...ids].sort(),
        12,
        async oddsId => [oddsId, await readOddsTable(reader, oddsId, kind, parse)] as const,
    )
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

function parseOptionalInteger(
    value: string | undefined,
    fieldName: string,
    source: string,
): number | undefined {
    const text = cleanOptionalId(value)
    if (!text) return undefined
    return parsePositiveInteger(text, fieldName, source)
}

function parseOptionalBoolean(value: string | undefined, fieldName: string, source: string): boolean {
    const text = cleanOptionalId(value)
    return text === undefined ? false : parseStrictBoolean(text, fieldName, source)
}

function requireBlank(value: string | undefined, fieldName: string, source: string): void {
    if (cleanOptionalId(value) !== undefined) {
        invalidGacha(`${fieldName} must be blank for this page kind in ${source}`)
    }
}

function buildPage(row: readonly string[], source: string): GachaRuntimePage {
    const kind = parseStrictInteger(row[4], "pageKind", source)
    switch (kind) {
        case 0:
            requireBlank(row[8], "tenTimesPerAccountCost", source)
            return {
                kind,
                singleCost: parsePositiveInteger(row[5], "singleCost", source),
                multiCost: parsePositiveInteger(row[6], "multiCost", source),
                dailyPaidCost: parsePositiveInteger(row[7], "discountCost", source),
            }
        case 1:
            requireBlank(row[5], "singleCost", source)
            requireBlank(row[6], "multiCost", source)
            requireBlank(row[7], "discountCost", source)
            return {
                kind,
                accountPaidTenCost: parsePositiveInteger(
                    row[8],
                    "tenTimesPerAccountCost",
                    source,
                ),
            }
        case 2:
        case 3:
        case 4:
        case 5:
            requireBlank(row[5], "singleCost", source)
            requireBlank(row[6], "multiCost", source)
            requireBlank(row[7], "discountCost", source)
            requireBlank(row[8], "tenTimesPerAccountCost", source)
            return { kind }
        case 8:
            requireBlank(row[7], "discountCost", source)
            requireBlank(row[8], "tenTimesPerAccountCost", source)
            return {
                kind,
                singleCost: parsePositiveInteger(row[5], "singleCost", source),
                multiCost: parsePositiveInteger(row[6], "multiCost", source),
            }
        default:
            return invalidGacha(`pageKind is unreachable in ${source}: ${kind}`)
    }
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
    if (raw.size !== rarityOdds.entries.length
        || [...raw.keys()].sort((left, right) => left - right).join(",") !== "3,4,5") {
        invalidGacha(`rarity odds ${rarityOdds.id} must contain each of rarities 3, 4 and 5 once`)
    }
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

function buildBanner(
    gachaId: string,
    row: string[],
    rarityOdds: Readonly<Record<string, OddsTable<RarityOddsEntry>>>,
): GachaRuntimeBanner {
    const source = `gacha[${gachaId}]`
    const isEquipment = row[13] === "1"
    const name = String(row[1] || `Gacha ${gachaId}`)
    const page = buildPage(row, source)
    const guaranteeNumber = parsePositiveInteger(row[9], "guaranteeNumber", source)
    if (guaranteeNumber !== 1) invalidGacha(`${source}.guaranteeNumber must be 1`)
    const guaranteeRarity = parsePositiveInteger(row[10], "guaranteeRarity", source)
    if (guaranteeRarity !== 4 && guaranteeRarity !== 5) {
        invalidGacha(`${source}.guaranteeRarity must be 4 or 5`)
    }
    const rarityOddsId = cleanOptionalId(row[11]) as string
    const rankRates = buildRankRates(rarityOdds[rarityOddsId], guaranteeRarity)
    if (rankRates.normal.reduce((sum, value) => sum + value, 0) !== 1000
        || rankRates.multiGuarantee.reduce((sum, value) => sum + value, 0) !== 1000) {
        invalidGacha(`${source}.rankRates must each sum to 1000`)
    }
    const onceTicketItemId = parseOptionalInteger(row[27], "onceTicketItemId", source)
    const tenTicketItemId = parseOptionalInteger(row[28], "tenTicketItemId", source)
    const crazyTenTicketItemId = parseOptionalInteger(row[45], "crazyTenTicketItemId", source)
    const startDate = row[29]
    const endDate = row[30]
    if (!startDate || !endDate) invalidGacha(`${source}.period must not be blank`)
    const ticketExpiryTime = cleanOptionalId(row[31])
    const extended = {
        guaranteeNumber,
        ...(ticketExpiryTime ? { ticketExpiryTime } : {}),
        showPeriod: parseOptionalBoolean(row[32], "showPeriod", source),
        isComeback: parseOptionalBoolean(row[43], "isComeback", source),
        freemiumGuaranteeAvailable: parseOptionalBoolean(
            row[44],
            "freemiumGuaranteeAvailable",
            source,
        ),
        isStarsGacha: parseOptionalBoolean(row[46], "isStarsGacha", source),
    }

    if (isEquipment) {
        const equipmentMovieProbabilityId = cleanOptionalId(row[25])
        const poolOddsIds = Object.fromEntries(Object.entries({
            "1": row[24], "2": row[23], "3": row[22],
        }).flatMap(([rank, value]) => {
            const id = cleanOptionalId(value)
            return id ? [[rank, id]] : []
        }))
        if (Object.keys(poolOddsIds).length !== 3) {
            invalidGacha(`${source}.poolOddsIds must contain all three ranks`)
        }
        if (!equipmentMovieProbabilityId) {
            invalidGacha(`${source}.equipmentMovieProbabilityId must not be blank`)
        }
        return {
            kind: "equipment",
            page,
            ...(onceTicketItemId ? { onceTicketItemId } : {}),
            ...(tenTicketItemId ? { tenTicketItemId } : {}),
            ...(crazyTenTicketItemId ? { crazyTenTicketItemId } : {}),
            wildcardTicketAvailable: parseOptionalBoolean(
                row[26],
                "wildcardTicketAvailable",
                source,
            ),
            rarityOddsId,
            guaranteeRarity,
            rankRates,
            equipmentMovieProbabilityId,
            startDate,
            endDate,
            name,
            ...extended,
            poolOddsIds,
        }
    }

    const poolOddsIds = Object.fromEntries(Object.entries({
        "1": row[16], "2": row[15], "3": row[14],
    }).flatMap(([rank, value]) => {
        const id = cleanOptionalId(value)
        return id ? [[rank, id]] : []
    }))
    if (Object.keys(poolOddsIds).length !== 3) {
        invalidGacha(`${source}.poolOddsIds must contain all three ranks`)
    }
    const movieName = cleanOptionalId(row[17])
    const guaranteeMovieName = cleanOptionalId(row[18])
    if (!movieName || !guaranteeMovieName) {
        invalidGacha(`${source}.movie names must not be blank`)
    }
    return {
        kind: "character",
        page,
        ...(onceTicketItemId ? { onceTicketItemId } : {}),
        ...(tenTicketItemId ? { tenTicketItemId } : {}),
        ...(crazyTenTicketItemId ? { crazyTenTicketItemId } : {}),
        wildcardTicketAvailable: parseOptionalBoolean(
            row[20],
            "wildcardTicketAvailable",
            source,
        ),
        rarityOddsId,
        guaranteeRarity,
        rankRates,
        movieName,
        guaranteeMovieName,
        toUseOddsUpAsTrialReading: parseOptionalBoolean(
            row[19],
            "toUseOddsUpAsTrialReading",
            source,
        ),
        canBeStartDashExchange: parseOptionalBoolean(
            row[21],
            "canBeStartDashExchange",
            source,
        ),
        startDate,
        endDate,
        name,
        ...extended,
        poolOddsIds,
    }
}

function buildCampaignDefinitions(
    rows: readonly OrderedMapTextRow[],
): Record<string, GachaCampaignDefinition> {
    const definitions: Record<string, GachaCampaignDefinition> = {}
    for (const [campaignIdText, fields] of requireRows(
        rows,
        "gacha_campaign",
        GACHA_CAMPAIGN_COLUMN_COUNT,
    )) {
        const campaignId = parseStrictInteger(campaignIdText, "campaignId", "gacha_campaign")
        const kind = parseStrictInteger(fields[2], "kind", `gacha_campaign[${campaignIdText}]`)
        if (kind !== 1 && kind !== 2) invalidGacha(`gacha_campaign[${campaignIdText}].kind is invalid`)
        const gachaIdTexts = fields[5].split(",")
        if (gachaIdTexts.length === 1 && gachaIdTexts[0] === "") {
            invalidGacha(`gacha_campaign[${campaignIdText}].gachaIds must not be empty`)
        }
        const gachaIds = gachaIdTexts.map(gachaIdText => parsePositiveInteger(
                gachaIdText,
                "gachaId",
                `gacha_campaign[${campaignIdText}]`,
            ))
        definitions[campaignIdText] = {
            campaignId,
            stringId: fields[0],
            title: fields[1],
            kind,
            availableFrom: fields[3],
            availableUntil: fields[4],
            gachaIds,
        }
    }
    return definitions
}

function buildStarsCampaigns(
    rows: readonly OrderedMapTextRow[],
): Record<string, StarsGachaCampaignDefinition> {
    return Object.fromEntries(requireRows(rows, "stars_gacha_campaign", 8).map(
        ([campaignIdText, fields]) => [campaignIdText, {
            campaignId: parsePositiveInteger(campaignIdText, "campaignId", "stars_gacha_campaign"),
            stringId: fields[0],
            title: fields[1],
            gachaId: parsePositiveInteger(fields[2], "gachaId", `stars_gacha_campaign[${campaignIdText}]`),
            availableFrom: fields[3],
            availableUntil: fields[4],
            oldPlayerDays: parsePositiveInteger(fields[5], "oldPlayerDays", `stars_gacha_campaign[${campaignIdText}]`),
            newPlayerDays: parsePositiveInteger(fields[6], "newPlayerDays", `stars_gacha_campaign[${campaignIdText}]`),
            maximumFreeGachaTimes: parsePositiveInteger(fields[7], "maximumFreeGachaTimes", `stars_gacha_campaign[${campaignIdText}]`),
        }],
    ))
}

function buildExchangeRates(
    characterRows: readonly OrderedMapTextRow[],
    equipmentRows: readonly OrderedMapTextRow[],
): GachaExchangeRates {
    const parse = (rows: readonly OrderedMapTextRow[], name: string) => Object.fromEntries(
        requireRows(rows, name, 1).map(([rarity, fields]) => [
            rarity,
            parsePositiveInteger(fields[0], "cost", `${name}[${rarity}]`),
        ]),
    )
    return {
        character: parse(characterRows, "character_exchange_rate"),
        equipment: parse(equipmentRows, "equipment_exchange_rate"),
    }
}

function buildSharedPools(
    characterOdds: Readonly<Record<string, OddsTable<CharacterOddsEntry>>>,
    equipmentOdds: Readonly<Record<string, OddsTable<EquipmentOddsEntry>>>,
): GachaPools {
    const pools: Record<string, GachaPoolItem[]> = {}
    for (const [id, odds] of Object.entries(characterOdds)) {
        pools[id] = normalizePoolEntries(odds.entries, "characterId")
    }
    for (const [id, odds] of Object.entries(equipmentOdds)) {
        if (pools[id] !== undefined) invalidGacha(`odds identity is shared across prize kinds: ${id}`)
        pools[id] = normalizePoolEntries(odds.entries, "equipmentId")
    }
    return pools
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
    const [
        rawGachaRows,
        campaignRows,
        featureRows,
        starsCampaignRows,
        characterExchangeRows,
        equipmentExchangeRows,
    ] = await Promise.all([
        reader.read(GACHA_PATH),
        reader.read(GACHA_CAMPAIGN_PATH),
        reader.readNested(GACHA_FEATURE_CONTENT_PATH),
        reader.read(STARS_GACHA_CAMPAIGN_PATH),
        reader.read(CHARACTER_EXCHANGE_RATE_PATH),
        reader.read(EQUIPMENT_EXCHANGE_RATE_PATH),
    ])
    const gachaRows = requireRows(rawGachaRows, "gacha", GACHA_COLUMN_COUNT)
    const ids = collectOddsIds(gachaRows)
    const [rarityOdds, characterOdds, equipmentOdds] = await Promise.all([
        readOddsGroup(reader, ids.rarity, "rarity", parseRarityOdds),
        readOddsGroup(reader, ids.character, "character", parseCharacterOdds),
        readOddsGroup(reader, ids.equipment, "equipment", parseEquipmentOdds),
    ])

    const gachas: Record<string, GachaRuntimeBanner> = {}
    const cdnGachas: Record<string, string[][]> = {}
    for (const [gachaId, fields] of gachaRows) {
        gachas[gachaId] = buildBanner(
            gachaId,
            fields,
            rarityOdds,
        )
        cdnGachas[gachaId] = [fields]
    }

    const campaignDefinitions = buildCampaignDefinitions(campaignRows)
    for (const definition of Object.values(campaignDefinitions)) {
        for (const gachaId of definition.gachaIds) {
            if (gachas[String(gachaId)] === undefined) {
                invalidGacha(`campaign ${definition.campaignId} references missing gacha ${gachaId}`)
            }
        }
    }
    const starsCampaigns = buildStarsCampaigns(starsCampaignRows)
    for (const definition of Object.values(starsCampaigns)) {
        if (gachas[String(definition.gachaId)] === undefined) {
            invalidGacha(`stars campaign ${definition.campaignId} references missing gacha ${definition.gachaId}`)
        }
    }

    return deepFreeze({
        "gacha.json": gachas,
        "gacha_campaign_definitions.json": campaignDefinitions,
        "stars_gacha_campaign.json": starsCampaigns,
        "gacha_exchange_rate.json": buildExchangeRates(characterExchangeRows, equipmentExchangeRows),
        "gacha_pool.json": buildSharedPools(characterOdds, equipmentOdds),
        "cdndata/gacha.json": cdnGachas,
        "cdndata/gacha_feature_content.json": buildFeatureContent(featureRows),
    })
}
