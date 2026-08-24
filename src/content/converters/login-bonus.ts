import { deepFreeze } from "../deep-freeze"
import { convertOrderedMapJson, type CsvOrderedMapTree } from "./ordered-map-json"

export const LOGIN_BONUS_SOURCE = "master/bonus/login_bonus.orderedmap"

export type LoginBonusReward = Readonly<{
    kind: 0 | 1 | 2 | 3 | 4
    id?: number
    count: number
}>

export interface LoginBonusEntry {
    readonly index: number
    readonly rewards: readonly LoginBonusReward[]
}

export interface NormalLoginBonusGroup {
    readonly availableFromMs: number
    readonly availableUntilMs: number | null
    readonly entries: readonly LoginBonusEntry[]
}

export type NormalLoginBonusCatalog = Readonly<Record<string, NormalLoginBonusGroup>>

export interface LoginBonusSourceReader {
    readDynamic(logicalPath: string): Promise<Buffer>
}

export interface LoginBonusConversionOutput {
    readonly "login_bonus_normal.json": NormalLoginBonusCatalog
}

function invalidLoginBonus(reason: string): never {
    throw new Error(`invalid login bonus content: ${reason}`)
}

function parsePositiveInteger(value: string | undefined, subject: string): number {
    if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        invalidLoginBonus(`${subject} must be a positive integer: ${String(value)}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidLoginBonus(`${subject} must be a safe integer`)
    return parsed
}

function parseJstTimestamp(value: string | undefined, subject: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value ?? "")
    if (match === null) invalidLoginBonus(`${subject} must be a JST date-time: ${String(value)}`)
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const hour = Number(hourText)
    const minute = Number(minuteText)
    const second = Number(secondText)
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    if (year < 1970 || year > 2200
        || month < 1 || month > 12
        || day < 1 || day > maxDay
        || hour > 23 || minute > 59 || second > 59) {
        invalidLoginBonus(`${subject} is outside the supported JST date-time range: ${value}`)
    }
    // The CN 1.8.1 bootstrap assigns the legacy JST-named client constant to UTC+8.
    return Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000
}

function requireGroupTree(
    groupId: string,
    node: CsvOrderedMapTree[string],
): CsvOrderedMapTree {
    if (Array.isArray(node)) invalidLoginBonus(`${groupId} must contain indexed entries`)
    return node as CsvOrderedMapTree
}

function requireSingleRow(
    groupId: string,
    index: string,
    node: CsvOrderedMapTree[string],
): readonly string[] {
    if (!Array.isArray(node) || node.length !== 1 || !Array.isArray(node[0])) {
        invalidLoginBonus(`${groupId}[${index}] must contain exactly one row`)
    }
    const row = node[0] as readonly string[]
    if (row.length !== 48) {
        invalidLoginBonus(`${groupId}[${index}] must have 48 columns, got ${row.length}`)
    }
    return row
}

function parseReward(
    fields: readonly string[],
    groupId: string,
    index: number,
    slot: number,
): LoginBonusReward | null {
    const kindColumn = 6 + slot * 4
    const rawKind = fields[kindColumn]
    if (rawKind === "" || rawKind === "(None)") return null
    if (!/^[0-4]$/.test(rawKind)) {
        invalidLoginBonus(`${groupId}[${index}].reward[${slot + 1}].kind is invalid: ${rawKind}`)
    }
    const kind = Number(rawKind) as LoginBonusReward["kind"]
    const count = parsePositiveInteger(
        fields[kindColumn + 1],
        `${groupId}[${index}].reward[${slot + 1}].count`,
    )
    if (kind === 1) {
        return {
            kind,
            id: parsePositiveInteger(
                fields[kindColumn + 2],
                `${groupId}[${index}].reward[${slot + 1}].itemId`,
            ),
            count,
        }
    }
    if (kind === 2) {
        if (count !== 1) {
            invalidLoginBonus(
                `${groupId}[${index}].reward[${slot + 1}].character count must be exactly 1`,
            )
        }
        return {
            kind,
            id: parsePositiveInteger(
                fields[kindColumn + 3],
                `${groupId}[${index}].reward[${slot + 1}].characterId`,
            ),
            count,
        }
    }
    return { kind, count }
}

function convertNormalGroup(groupId: string, tree: CsvOrderedMapTree): NormalLoginBonusGroup | null {
    const indices = Object.keys(tree)
        .map(index => parsePositiveInteger(index, `${groupId}.index`))
        .sort((left, right) => left - right)
    if (indices.length === 0 || indices.some((index, offset) => index !== offset + 1)) {
        invalidLoginBonus(`${groupId} indices must start at 1 and be contiguous`)
    }

    const rows = indices.map(index => requireSingleRow(groupId, String(index), tree[String(index)]))
    const groupTypes = new Set(rows.map(fields => fields[0]))
    if (groupTypes.size !== 1) invalidLoginBonus(`${groupId} has inconsistent group types`)
    if (rows[0][0] !== "0") return null

    const periods = rows.map(fields => ({
        availableFromMs: parseJstTimestamp(fields[41], `${groupId}.availableFrom`),
        availableUntilMs: fields[42] === "(None)"
            ? null
            : parseJstTimestamp(fields[42], `${groupId}.availableUntil`),
    }))
    const firstPeriod = periods[0]
    if (periods.some(period => (
        period.availableFromMs !== firstPeriod.availableFromMs
        || period.availableUntilMs !== firstPeriod.availableUntilMs
    ))) {
        invalidLoginBonus(`${groupId} has inconsistent availability periods`)
    }
    if (firstPeriod.availableUntilMs !== null
        && firstPeriod.availableUntilMs < firstPeriod.availableFromMs) {
        invalidLoginBonus(`${groupId} availability period is inverted`)
    }

    const entries = rows.map((fields, offset) => {
        const rewards = Array.from({ length: 7 }, (_, slot) => (
            parseReward(fields, groupId, offset + 1, slot)
        )).filter((reward): reward is LoginBonusReward => reward !== null)
        if (rewards.length === 0) invalidLoginBonus(`${groupId}[${offset + 1}] has no rewards`)
        return { index: offset + 1, rewards }
    })
    return {
        availableFromMs: firstPeriod.availableFromMs,
        availableUntilMs: firstPeriod.availableUntilMs,
        entries,
    }
}

export function convertLoginBonusTree(tree: CsvOrderedMapTree): NormalLoginBonusCatalog {
    const output: Record<string, NormalLoginBonusGroup> = {}
    for (const groupId of Object.keys(tree).sort()) {
        if (groupId.length === 0) invalidLoginBonus("group id must not be empty")
        const group = convertNormalGroup(groupId, requireGroupTree(groupId, tree[groupId]))
        if (group !== null) output[groupId] = group
    }
    if (Object.keys(output).length === 0) invalidLoginBonus("no Normal groups were found")
    return deepFreeze(output)
}

export async function convertLoginBonuses(
    reader: LoginBonusSourceReader,
): Promise<LoginBonusConversionOutput> {
    const raw = await reader.readDynamic(LOGIN_BONUS_SOURCE)
    return deepFreeze({
        "login_bonus_normal.json": convertLoginBonusTree(convertOrderedMapJson(raw, 2)),
    })
}

export function selectActiveNormalLoginBonusGroup(
    catalog: NormalLoginBonusCatalog,
    virtualNowMs: number,
): Readonly<{ groupId: string; group: NormalLoginBonusGroup }> | null {
    if (!Number.isFinite(virtualNowMs)) throw new TypeError("virtualNowMs must be finite")
    const active = Object.entries(catalog)
        .filter(([, group]) => (
            group.availableFromMs <= virtualNowMs
            && (group.availableUntilMs === null || virtualNowMs <= group.availableUntilMs)
        ))
        .sort(([leftId, left], [rightId, right]) => (
            left.availableFromMs - right.availableFromMs || leftId.localeCompare(rightId)
        ))
    if (active.length === 0) return null
    return { groupId: active[0][0], group: active[0][1] }
}
