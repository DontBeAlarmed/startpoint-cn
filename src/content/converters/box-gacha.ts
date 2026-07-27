import { deepFreeze } from "../deep-freeze"
import {
    parseNestedOrderedMapRows,
    parseTextOrderedMap,
    type OrderedMapTextRow,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const BOX_GACHA_PATH = "master/box_gacha/box_gacha.orderedmap"
const BOX_REWARD_PATH = "master/box_gacha/box_reward.orderedmap"
const BOX_SETTINGS_PATH = "master/box_gacha/box.orderedmap"
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/

export interface BoxGachaSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
    readBytes(logicalPath: string): Promise<Buffer>
}

export interface BoxGachaConversionOutput {
    readonly "box_gacha.json": Readonly<Record<string, unknown>>
    readonly "box_gacha_box_settings.json": Readonly<Record<string, unknown>>
    readonly "box_reward.json": Readonly<Record<string, unknown>>
}

function invalidBoxGacha(reason: string): never {
    throw new Error(`invalid box gacha content: ${reason}`)
}

function compareIds(left: string, right: string): number {
    return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

function requireId(value: string, subject: string): string {
    if (!POSITIVE_INTEGER_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
        invalidBoxGacha(`${subject} must be a canonical positive integer: ${value}`)
    }
    return value
}

function parseInteger(value: string, subject: string): number {
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
        invalidBoxGacha(`${subject} must be a non-negative integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidBoxGacha(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed === 0) invalidBoxGacha(`${subject} must be a positive integer: ${value}`)
    return parsed
}

function parseOptionalInteger(value: string, subject: string): number | null {
    return value === "" || value === "(None)" ? null : parseInteger(value, subject)
}

function parseDate(value: string, subject: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) invalidBoxGacha(`${subject} must be a JST date-time: ${value}`)
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, 0)
    const normalized = [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        invalidBoxGacha(`${subject} must be a valid JST date-time: ${value}`)
    }
    return value
}

function parseOptionalDate(value: string, subject: string): string | null {
    return value === "" || value === "(None)" ? null : parseDate(value, subject)
}

function parseFields(
    row: OrderedMapTextRow,
    tableName: string,
    columnCount: number,
): readonly string[] {
    const fields = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidBoxGacha)
    if (fields.length !== columnCount) {
        invalidBoxGacha(`${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`)
    }
    return fields
}

function sortedTextRows(rows: readonly OrderedMapTextRow[]): OrderedMapTextRow[] {
    return [...rows].sort((left, right) => compareIds(left.key, right.key))
}

function parseRewards(raw: Buffer): {
    rewards: Record<string, Record<string, Record<string, unknown>>>
    availableCounts: Record<string, Record<string, number>>
} {
    const rewards: Record<string, Record<string, Record<string, unknown>>> = {}
    const availableCounts: Record<string, Record<string, number>> = {}
    const gachas = [...parseNestedOrderedMapRows(raw)]
        .sort((left, right) => compareIds(left.key, right.key))
    for (const gacha of gachas) {
        const gachaId = requireId(gacha.key, "box_reward gacha key")
        const boxes: Record<string, Record<string, unknown>> = {}
        const totals: Record<string, number> = {}
        const boxRows = [...parseNestedOrderedMapRows(gacha.value)]
            .sort((left, right) => compareIds(left.key, right.key))
        for (const box of boxRows) {
            const boxId = requireId(box.key, `box_reward[${gachaId}] box key`)
            const converted: Record<string, unknown> = {}
            let total = 0
            for (const row of sortedTextRows(parseTextOrderedMap(box.value))) {
                requireId(row.key, `box_reward[${gachaId}][${boxId}] row key`)
                const fields = parseFields(row, "box_reward", 7)
                const rewardId = requireId(
                    fields[0],
                    `box_reward[${gachaId}][${boxId}][${row.key}].id`,
                )
                if (Object.prototype.hasOwnProperty.call(converted, rewardId)) {
                    invalidBoxGacha(`box_reward[${gachaId}][${boxId}] has duplicate reward ${rewardId}`)
                }
                const available = parsePositiveInteger(
                    fields[5],
                    `box_reward[${gachaId}][${boxId}][${rewardId}].available`,
                )
                total += available
                if (!Number.isSafeInteger(total)) {
                    invalidBoxGacha(`box_reward[${gachaId}][${boxId}] total is unsafe`)
                }
                const itemId = parseOptionalInteger(
                    fields[3],
                    `box_reward[${gachaId}][${boxId}][${rewardId}].itemId`,
                )
                converted[rewardId] = {
                    type: parseInteger(
                        fields[2],
                        `box_reward[${gachaId}][${boxId}][${rewardId}].type`,
                    ),
                    count: parsePositiveInteger(
                        fields[4],
                        `box_reward[${gachaId}][${boxId}][${rewardId}].count`,
                    ),
                    available,
                    tier: parseInteger(
                        fields[6],
                        `box_reward[${gachaId}][${boxId}][${rewardId}].tier`,
                    ),
                    ...(itemId === null ? {} : { id: itemId }),
                }
            }
            if (Object.keys(converted).length === 0) {
                invalidBoxGacha(`box_reward[${gachaId}][${boxId}] must contain rewards`)
            }
            boxes[boxId] = converted
            totals[boxId] = total
        }
        rewards[gachaId] = boxes
        availableCounts[gachaId] = totals
    }
    return { rewards, availableCounts }
}

function parseSettings(raw: Buffer): Record<string, Record<string, unknown>> {
    const output: Record<string, Record<string, unknown>> = {}
    const gachas = [...parseNestedOrderedMapRows(raw)]
        .sort((left, right) => compareIds(left.key, right.key))
    for (const gacha of gachas) {
        const gachaId = requireId(gacha.key, "box settings gacha key")
        const boxes: Record<string, unknown> = {}
        for (const row of sortedTextRows(parseTextOrderedMap(gacha.value))) {
            const boxId = requireId(row.key, `box settings[${gachaId}] box key`)
            const fields = parseFields(row, "box_gacha_box_settings", 16)
            const resetKind = parseInteger(fields[11], `box settings[${gachaId}][${boxId}].resetKind`)
            const closeKind = parseInteger(fields[15], `box settings[${gachaId}][${boxId}].closeKind`)
            if (resetKind !== 0 && resetKind !== 2) {
                invalidBoxGacha(`box settings[${gachaId}][${boxId}].resetKind is unsupported`)
            }
            if (closeKind !== 0 && closeKind !== 1) {
                invalidBoxGacha(`box settings[${gachaId}][${boxId}].closeKind is unsupported`)
            }
            const requiredBoxId = parseOptionalInteger(
                fields[3],
                `box settings[${gachaId}][${boxId}].requiredBoxId`,
            )
            if (requiredBoxId === 0) {
                invalidBoxGacha(`box settings[${gachaId}][${boxId}].requiredBoxId must be positive`)
            }
            boxes[boxId] = {
                requiredBoxId,
                resetKind,
                resetLimit: parseOptionalInteger(
                    fields[12],
                    `box settings[${gachaId}][${boxId}].resetLimit`,
                ),
                availableFrom: parseDate(
                    fields[13],
                    `box settings[${gachaId}][${boxId}].availableFrom`,
                ),
                availableUntil: parseOptionalDate(
                    fields[14],
                    `box settings[${gachaId}][${boxId}].availableUntil`,
                ),
                closeKind,
            }
        }
        output[gachaId] = boxes
    }
    return output
}

function requireSameKeys(left: object, right: object, subject: string): void {
    const leftKeys = Object.keys(left).sort(compareIds)
    const rightKeys = Object.keys(right).sort(compareIds)
    if (leftKeys.length !== rightKeys.length
        || leftKeys.some((key, index) => key !== rightKeys[index])) {
        invalidBoxGacha(`${subject} do not match`)
    }
}

export async function convertBoxGachaTables(
    reader: BoxGachaSourceReader,
): Promise<BoxGachaConversionOutput> {
    const [gachaRows, rewardRaw, settingsRaw] = await Promise.all([
        reader.read(BOX_GACHA_PATH),
        reader.readBytes(BOX_REWARD_PATH),
        reader.readBytes(BOX_SETTINGS_PATH),
    ])
    const { rewards, availableCounts } = parseRewards(rewardRaw)
    const settings = parseSettings(settingsRaw)
    const gachas: Record<string, unknown> = {}
    for (const row of sortedTextRows(gachaRows)) {
        const gachaId = requireId(row.key, "box_gacha key")
        const fields = parseFields(row, "box_gacha", 8)
        gachas[gachaId] = {
            itemId: parsePositiveInteger(fields[2], `box_gacha[${gachaId}].itemId`),
            count: parsePositiveInteger(fields[3], `box_gacha[${gachaId}].count`),
            availableCounts: availableCounts[gachaId],
        }
    }
    requireSameKeys(gachas, rewards, "box gacha and reward gacha sets")
    requireSameKeys(gachas, settings, "box gacha and settings gacha sets")
    for (const gachaId of Object.keys(gachas)) {
        requireSameKeys(
            rewards[gachaId],
            settings[gachaId],
            `box gacha ${gachaId} box sets`,
        )
    }
    return deepFreeze({
        "box_gacha.json": gachas,
        "box_gacha_box_settings.json": settings,
        "box_reward.json": rewards,
    })
}
