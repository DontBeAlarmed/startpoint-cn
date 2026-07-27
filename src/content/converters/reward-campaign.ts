import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

export const REWARD_CAMPAIGN_PATH = "master/campaign/reward_campaign.orderedmap"

const CATEGORY_BY_QUEST_KIND: readonly (readonly number[])[] = [
    [1], [4], [2], [6], [14], [7], [10], [13], [11], [18], [19], [15],
    [6, 14, 13, 20], [20], [21], [22], [23], [24], [25], [26], [27],
]

export interface RewardCampaignSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface RewardCampaignConversionOutput {
    readonly "reward_campaign.json": Readonly<Record<string, unknown>>
}

function invalidCampaign(reason: string): never {
    throw new Error(`invalid reward campaign content: ${reason}`)
}

function parseInteger(value: string, subject: string): number {
    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) invalidCampaign(`${subject} must be an integer`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidCampaign(`${subject} must be a safe integer`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed <= 0) invalidCampaign(`${subject} must be positive`)
    return parsed
}

function parseJstTimestamp(value: string, subject: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) return invalidCampaign(`${subject} must be a JST timestamp`)
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const utc = new Date(0)
    utc.setUTCFullYear(year, month - 1, day)
    utc.setUTCHours(hour, minute, second, 0)
    const normalized = [
        utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(),
        utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        return invalidCampaign(`${subject} is not a real timestamp`)
    }
    return utc.getTime() - 9 * 60 * 60 * 1000
}

function parseOptionalList(value: string, subject: string): readonly number[] | null {
    if (value === "(None)") return null
    if (value === "") return []
    const values = value.split(",").map((part, index) => (
        parsePositiveInteger(part, `${subject}[${index}]`)
    ))
    if (new Set(values).size !== values.length) invalidCampaign(`${subject} contains duplicates`)
    return values
}

function parseOptionalId(value: string, subject: string): readonly number[] | null {
    if (value === "(None)") return null
    return [parsePositiveInteger(value, subject)]
}

function questRange(fields: readonly string[], questKind: number): {
    categories: readonly number[]
    keyQueries: readonly (readonly number[] | null)[]
} {
    const categories = CATEGORY_BY_QUEST_KIND[questKind]
    if (categories === undefined) invalidCampaign(`quest kind is unsupported: ${questKind}`)
    if (questKind <= 2) {
        return {
            categories,
            keyQueries: [8, 9, 10].map(column => (
                parseOptionalList(fields[column], `quest kind ${questKind} query ${column}`)
            )),
        }
    }
    if (questKind === 11) {
        return {
            categories,
            keyQueries: [parseOptionalList(fields[10], "practice quest query")],
        }
    }
    if (questKind === 12) return { categories, keyQueries: [] }
    return {
        categories,
        keyQueries: [
            parseOptionalId(fields[8], `quest kind ${questKind} event id`),
            parseOptionalList(fields[10], `quest kind ${questKind} quest ids`),
        ],
    }
}

export async function convertRewardCampaigns(
    reader: RewardCampaignSourceReader,
): Promise<RewardCampaignConversionOutput> {
    const rows = await reader.read(REWARD_CAMPAIGN_PATH)
    const output: Record<string, unknown> = {}
    for (const row of rows) {
        if (!/^[1-9]\d*$/.test(row.key) || output[row.key] !== undefined) {
            invalidCampaign(`campaign key must be a unique positive integer: ${row.key}`)
        }
        const fields = parseCsvLine(
            row.text,
            `reward_campaign[${row.key}]`,
            invalidCampaign,
        )
        if (fields.length !== 11) {
            invalidCampaign(`reward_campaign[${row.key}] must have 11 columns`)
        }
        const repeatKind = parseInteger(fields[0], `reward_campaign[${row.key}].repeatKind`)
        if (repeatKind !== 0) invalidCampaign("weekly campaigns are not supported")
        const startAtMs = parseJstTimestamp(fields[1], `reward_campaign[${row.key}].startAt`)
        const endAtMs = parseJstTimestamp(fields[2], `reward_campaign[${row.key}].endAt`)
        if (endAtMs < startAtMs) invalidCampaign(`reward_campaign[${row.key}] has an inverted period`)
        const rewardKind = parseInteger(fields[5], `reward_campaign[${row.key}].rewardKind`)
        if (rewardKind < 0 || rewardKind > 2) invalidCampaign(`reward kind is unsupported: ${rewardKind}`)
        const rate = Number(fields[6])
        if (!Number.isFinite(rate) || rate < 1) invalidCampaign("campaign rate must be at least 1")
        const questKind = parseInteger(fields[7], `reward_campaign[${row.key}].questKind`)
        const range = questRange(fields, questKind)
        output[row.key] = {
            id: Number(row.key),
            startAtMs,
            endAtMs,
            rewardKind,
            rate,
            ...range,
        }
    }
    return deepFreeze({ "reward_campaign.json": output })
}
