import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

export const GROWTH_FUND_PATH = "master/growth_fund/growth_fund.orderedmap"

// Column count follows the client's GrowthFundValues.as constructor
// (positional array authority).
const GROWTH_FUND_COLUMN_COUNT = 19

export type GrowthFundKind =
    | { readonly index: 0, readonly laiteRankThreshold: number }
    | { readonly index: 1, readonly mainQuestId: number }
    | { readonly index: 2, readonly exQuestId: number }

export type GrowthFundReward =
    | { readonly kind: "stone" }
    | { readonly kind: "item", readonly itemId: number, readonly count: number }

export interface GrowthFundBonusDefinition {
    readonly bonusId: number
    readonly displayOrder: number
    readonly thumbnailId: string
    readonly questThumbnailId: string
    readonly kind: GrowthFundKind
    readonly reward1: GrowthFundReward | null
    readonly reward2: GrowthFundReward | null
    readonly chargeVmoneyNum: number
    readonly freeVmoneyNum: number
    readonly name: string
    readonly rewardNumberText: number
    readonly rewardDescription: string
}

export interface GrowthFundSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface GrowthFundConversionOutput {
    readonly "growth_fund.json": Readonly<Record<string, GrowthFundBonusDefinition>>
}

function invalid(reason: string): never {
    throw new Error(`invalid growth fund content: ${reason}`)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

const BONUS_KEY_PATTERN = /^[1-9]\d*$/
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

function parseReward(
    discriminator: string,
    itemIdText: string,
    countText: string,
    subject: string,
): GrowthFundReward | null {
    if (discriminator === "(None)") return null
    if (discriminator === "0") return { kind: "stone" }
    if (discriminator === "1") {
        return {
            kind: "item",
            itemId: parseInteger(itemIdText, `${subject}.itemId`, BONUS_KEY_PATTERN),
            count: parseInteger(countText, `${subject}.count`, NON_NEGATIVE_INTEGER_PATTERN),
        }
    }
    return invalid(`${subject} reward discriminator must be (None)/0/1: ${discriminator}`)
}

/**
 * Validates the converted runtime bonus table so release readers and the
 * runtime accessor share converter invariants.
 */
export function validateGrowthFundTable(
    raw: unknown,
): Readonly<Record<string, GrowthFundBonusDefinition>> {
    if (!isRecord(raw)) invalid("bonus catalog root must be an object")
    const table = raw as Readonly<Record<string, unknown>>
    if (Object.keys(table).length === 0) invalid("bonus catalog must not be empty")
    for (const [idText, rawEntry] of Object.entries(table)) {
        if (!BONUS_KEY_PATTERN.test(idText)) {
            invalid(`bonus key must be a canonical positive integer: ${idText}`)
        }
        if (!isRecord(rawEntry)) invalid(`bonus ${idText} must be an object`)
        const entry = rawEntry as Readonly<Record<string, unknown>>
        if (entry.bonusId !== Number(idText)) {
            invalid(`bonus ${idText} id does not match key`)
        }
        const kind = entry.kind as GrowthFundKind | undefined
        if (kind === undefined || typeof kind.index !== "number") {
            invalid(`bonus ${idText} kind is missing`)
        }
        if (kind.index === 0) {
            if (typeof kind.laiteRankThreshold !== "number" || kind.laiteRankThreshold < 1) {
                invalid(`bonus ${idText} laite rank threshold must be >= 1`)
            }
        } else if (kind.index === 1) {
            if (typeof kind.mainQuestId !== "number" || kind.mainQuestId < 1) {
                invalid(`bonus ${idText} main quest id must be >= 1`)
            }
        } else if (kind.index === 2) {
            if (typeof kind.exQuestId !== "number" || kind.exQuestId < 1) {
                invalid(`bonus ${idText} ex quest id must be >= 1`)
            }
        } else {
            invalid(`bonus ${idText} kind index must be 0/1/2`)
        }
        for (const rewardKey of ["reward1", "reward2"] as const) {
            const rawReward: unknown = entry[rewardKey]
            if (rawReward === null || rawReward === undefined) continue
            if (typeof rawReward !== "object") {
                invalid(`bonus ${idText} ${rewardKey} must be a reward object`)
            }
            const reward = rawReward as GrowthFundReward
            if (reward.kind === "item"
                && (typeof reward.itemId !== "number"
                    || reward.itemId < 1
                    || typeof reward.count !== "number"
                    || reward.count < 1)) {
                invalid(`bonus ${idText} ${rewardKey} item reward is invalid`)
            }
        }
        if (typeof entry.chargeVmoneyNum !== "number"
            || entry.chargeVmoneyNum < 0
            || typeof entry.freeVmoneyNum !== "number"
            || entry.freeVmoneyNum < 0) {
            invalid(`bonus ${idText} vmoney numbers must be non-negative`)
        }
        const isStoneReward = (value: unknown): boolean => (
            typeof value === "object" && value !== null
            && (value as GrowthFundReward).kind === "stone"
        )
        const hasStoneReward = isStoneReward(entry.reward1) || isStoneReward(entry.reward2)
        if (hasStoneReward && entry.chargeVmoneyNum === 0 && entry.freeVmoneyNum === 0) {
            invalid(`bonus ${idText} declares a stone reward with no stone amount`)
        }
        if (typeof entry.name !== "string" || entry.name === "") {
            invalid(`bonus ${idText} name is invalid`)
        }
        if (typeof entry.rewardNumberText !== "number"
            || !Number.isSafeInteger(entry.rewardNumberText)) {
            invalid(`bonus ${idText} rewardNumberText must be an integer`)
        }
        if (typeof entry.rewardDescription !== "string") {
            invalid(`bonus ${idText} rewardDescription must be a string`)
        }
    }
    return deepFreeze(table as Readonly<Record<string, GrowthFundBonusDefinition>>)
}

function parseBonusRow(key: string, fields: readonly string[]): GrowthFundBonusDefinition {
    const subject = `growth_fund[${key}]`
    if (fields.length !== GROWTH_FUND_COLUMN_COUNT) {
        invalid(`${subject} must have ${GROWTH_FUND_COLUMN_COUNT} columns, got ${fields.length}`)
    }
    const kindDiscriminator = fields[4]
    let kind: GrowthFundKind
    if (kindDiscriminator === "0") {
        kind = {
            index: 0,
            laiteRankThreshold: parseInteger(fields[5], `${subject}.laiteRank`, NON_NEGATIVE_INTEGER_PATTERN),
        }
    } else if (kindDiscriminator === "1") {
        kind = { index: 1, mainQuestId: parseInteger(fields[6], `${subject}.mainQuestId`, BONUS_KEY_PATTERN) }
    } else if (kindDiscriminator === "2") {
        kind = { index: 2, exQuestId: parseInteger(fields[7], `${subject}.exQuestId`, BONUS_KEY_PATTERN) }
    } else {
        return invalid(`${subject} fund kind discriminator must be 0/1/2: ${kindDiscriminator}`)
    }
    const chargeVmoneyNum = parseInteger(fields[14], `${subject}.chargeVmoneyNum`, NON_NEGATIVE_INTEGER_PATTERN)
    const freeVmoneyNum = parseInteger(fields[15], `${subject}.freeVmoneyNum`, NON_NEGATIVE_INTEGER_PATTERN)
    return {
        bonusId: Number(key),
        displayOrder: parseInteger(fields[1], `${subject}.displayOrder`, INTEGER_PATTERN),
        thumbnailId: fields[2],
        questThumbnailId: fields[3],
        kind,
        reward1: parseReward(fields[8], fields[9], fields[10], `${subject}.reward1`),
        reward2: parseReward(fields[11], fields[12], fields[13], `${subject}.reward2`),
        chargeVmoneyNum,
        freeVmoneyNum,
        name: fields[16],
        rewardNumberText: parseInteger(fields[17], `${subject}.rewardNumberText`, INTEGER_PATTERN),
        rewardDescription: fields[18],
    }
}

export async function convertGrowthFundTables(
    reader: GrowthFundSourceReader,
): Promise<GrowthFundConversionOutput> {
    const bonusRows = await reader.read(GROWTH_FUND_PATH)

    const bonuses: Record<string, GrowthFundBonusDefinition> = {}
    for (const row of bonusRows) {
        if (!BONUS_KEY_PATTERN.test(row.key) || bonuses[row.key] !== undefined) {
            invalid(`bonus key must be a unique positive integer: ${row.key}`)
        }
        bonuses[row.key] = parseBonusRow(
            row.key,
            parseCsvLine(row.text, `growth_fund[${row.key}]`, invalid),
        )
    }
    if (Object.keys(bonuses).length === 0) {
        invalid("growth_fund must not be empty")
    }

    return deepFreeze({
        "growth_fund.json": validateGrowthFundTable(bonuses),
    })
}
