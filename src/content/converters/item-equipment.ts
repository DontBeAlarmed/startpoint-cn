import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const EQUIPMENT_PATH = "master/item/equipment.orderedmap"
const EQUIPMENT_CRAFT_PATH = "master/item/equipment_craft_point_exchange.orderedmap"
const EQUIPMENT_DISSOLVE_RATE_PATH = "master/item/equipment_dissolve_rate.orderedmap"
const ITEM_PATH = "master/item/item.orderedmap"
const ITEM_BONUS_SELECT_PATH = "master/item/item_bonus_select.orderedmap"

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/

export interface ItemEquipmentSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface ItemEquipmentConversionOutput {
    readonly "equipment_craft.json": Readonly<Record<string, unknown>>
    readonly "equipment_dissolve.json": Readonly<Record<string, unknown>>
    readonly "equipment_ids.json": readonly number[]
    readonly "equipment_lookup.json": Readonly<Record<string, unknown>>
    readonly "item_data.json": Readonly<Record<string, unknown>>
    readonly "item_ids.json": readonly number[]
    readonly "item_lookup.json": Readonly<Record<string, string>>
    readonly "item_max_count.json": Readonly<Record<string, number>>
    readonly "item_sale.json": Readonly<Record<string, unknown>>
}

export interface ItemEquipmentConversionCompatibility {
    readonly equipmentLookup: Readonly<Record<string, {
        readonly category?: unknown
    }>>
}

type ParsedRow = readonly [string, readonly string[]]

function invalidItemEquipment(reason: string): never {
    throw new Error(`invalid item/equipment content: ${reason}`)
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
            if (!POSITIVE_INTEGER_PATTERN.test(row.key)
                || !Number.isSafeInteger(Number(row.key))) {
                invalidItemEquipment(
                    `${tableName} key must be a canonical positive integer: ${row.key}`,
                )
            }
            if (seen.has(row.key)) {
                invalidItemEquipment(`${tableName} has duplicate key: ${row.key}`)
            }
            seen.add(row.key)
            const fields = parseCsvLine(
                row.text,
                `${tableName}[${row.key}]`,
                invalidItemEquipment,
            )
            if (fields.length !== columnCount) {
                invalidItemEquipment(
                    `${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`,
                )
            }
            return [row.key, fields] as const
        })
}

function parseNonNegativeInteger(value: string, subject: string): number {
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
        invalidItemEquipment(`${subject} must be a non-negative integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalidItemEquipment(`${subject} must be a safe integer: ${value}`)
    }
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
        invalidItemEquipment(`${subject} must be a positive integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalidItemEquipment(`${subject} must be a safe integer: ${value}`)
    }
    return parsed
}

function parseBoolean(value: string, subject: string): boolean {
    if (/^true$/i.test(value)) return true
    if (/^false$/i.test(value)) return false
    invalidItemEquipment(`${subject} must be a boolean: ${value}`)
}

function requireText(value: string, subject: string): string {
    if (value === "" || value === "(None)") {
        invalidItemEquipment(`${subject} must be present`)
    }
    return value
}

function convertEquipment(
    rows: readonly OrderedMapTextRow[],
    compatibility: ItemEquipmentConversionCompatibility,
): {
    readonly dissolve: Record<string, unknown>
    readonly ids: number[]
    readonly lookup: Record<string, unknown>
} {
    const dissolve: Record<string, unknown> = {}
    const ids: number[] = []
    const lookup: Record<string, unknown> = {}
    for (const [id, fields] of parseRows(rows, "equipment", 16)) {
        ids.push(Number(id))
        dissolve[id] = {
            ability_soul_id: parsePositiveInteger(
                fields[10],
                `equipment[${id}].abilitySoulId`,
            ),
            obtain_source: parseNonNegativeInteger(
                fields[15],
                `equipment[${id}].obtainSource`,
            ),
            generate_ability_soul: parseBoolean(
                fields[9],
                `equipment[${id}].generateAbilitySoul`,
            ),
            max_level: parsePositiveInteger(fields[8], `equipment[${id}].maxLevel`),
        }
        const configuredCategory = compatibility.equipmentLookup[id]?.category
        lookup[id] = {
            name: requireText(fields[1], `equipment[${id}].name`),
            rarity: String(parsePositiveInteger(fields[11], `equipment[${id}].rarity`)),
            category: typeof configuredCategory === "string" && configuredCategory.length > 0
                ? configuredCategory
                : "未分类",
        }
    }
    return { dissolve, ids, lookup }
}

function convertEquipmentCraft(
    craftRows: readonly OrderedMapTextRow[],
    dissolveRateRows: readonly OrderedMapTextRow[],
): Record<string, unknown> {
    const craft = parseRows(craftRows, "equipment_craft_point_exchange", 2)
    const dissolveRates = parseRows(dissolveRateRows, "equipment_dissolve_rate", 1)
    const craftKeys = craft.map(([id]) => id)
    const dissolveRateKeys = dissolveRates.map(([id]) => id)
    if (craftKeys.length !== dissolveRateKeys.length
        || craftKeys.some((id, index) => id !== dissolveRateKeys[index])) {
        invalidItemEquipment("equipment craft rarity keys do not match dissolve rates")
    }

    const dissolveByRarity = new Map(dissolveRates)
    const output: Record<string, unknown> = {}
    for (const [rarity, fields] of craft) {
        const dissolveFields = dissolveByRarity.get(rarity)
        if (!dissolveFields) {
            invalidItemEquipment("equipment craft rarity keys do not match dissolve rates")
        }
        output[rarity] = {
            dissolve_craft: parseNonNegativeInteger(
                fields[0],
                `equipment_craft_point_exchange[${rarity}].dissolveCraft`,
            ),
            awakening_craft: parseNonNegativeInteger(
                fields[1],
                `equipment_craft_point_exchange[${rarity}].awakeningCraft`,
            ),
            dissolve_star: parseNonNegativeInteger(
                dissolveFields[0],
                `equipment_dissolve_rate[${rarity}].dissolveStar`,
            ),
        }
    }
    return output
}

interface SelectReward {
    readonly itemId: number
    readonly amount: number
}

function convertItemBonusSelect(
    rows: readonly OrderedMapTextRow[],
): ReadonlyMap<string, readonly SelectReward[]> {
    const output = new Map<string, readonly SelectReward[]>()
    for (const [id, fields] of parseRows(rows, "item_bonus_select", 20)) {
        const rewards: SelectReward[] = []
        const seenItemIds = new Set<number>()
        for (let index = 0; index < 6; index += 1) {
            const candidateNumber = index + 1
            const offset = 1 + index * 3
            const kind = fields[offset]
            if (kind !== "1") {
                invalidItemEquipment(
                    `item_bonus_select[${id}] candidate ${candidateNumber} kind must be Item (1): ${kind}`,
                )
            }
            const amount = parsePositiveInteger(
                requireText(
                    fields[offset + 1],
                    `item_bonus_select[${id}] candidate ${candidateNumber} amount`,
                ),
                `item_bonus_select[${id}] candidate ${candidateNumber} amount`,
            )
            const itemId = parsePositiveInteger(
                requireText(
                    fields[offset + 2],
                    `item_bonus_select[${id}] candidate ${candidateNumber} itemId`,
                ),
                `item_bonus_select[${id}] candidate ${candidateNumber} itemId`,
            )
            if (seenItemIds.has(itemId)) {
                invalidItemEquipment(
                    `item_bonus_select[${id}] has duplicate Item candidate: ${itemId}`,
                )
            }
            seenItemIds.add(itemId)
            rewards.push({ itemId, amount })
        }
        output.set(id, rewards)
    }
    return output
}

function convertItems(
    rows: readonly OrderedMapTextRow[],
    bonusSelect: ReadonlyMap<string, readonly SelectReward[]>,
): {
    readonly data: Record<string, unknown>
    readonly ids: number[]
    readonly lookup: Record<string, string>
    readonly maxCount: Record<string, number>
    readonly sale: Record<string, unknown>
} {
    const data: Record<string, unknown> = {}
    const ids: number[] = []
    const lookup: Record<string, string> = {}
    const maxCount: Record<string, number> = {}
    const sale: Record<string, unknown> = {}
    for (const [id, fields] of parseRows(rows, "item", 23)) {
        ids.push(Number(id))
        lookup[id] = requireText(fields[2], `item[${id}].name`)
        maxCount[id] = parsePositiveInteger(fields[18], `item[${id}].maxCount`)
        const effectKind = parseNonNegativeInteger(fields[6], `item[${id}].effectKind`)
        if (effectKind === 2 || effectKind === 3) {
            data[id] = {
                effectKind,
                effectValue: parsePositiveInteger(fields[7], `item[${id}].effectValue`),
            }
        } else if (effectKind === 22) {
            const selectBonusId = String(parsePositiveInteger(
                requireText(fields[22], `item[${id}].selectBonusId`),
                `item[${id}].selectBonusId`,
            ))
            const selectRewards = bonusSelect.get(selectBonusId)
            if (!selectRewards) {
                invalidItemEquipment(
                    `item[${id}].selectBonusId references missing item_bonus_select: ${selectBonusId}`,
                )
            }
            data[id] = {
                effectKind: 22,
                effectValue: 0,
                selectRewards,
            }
        }
        sale[id] = {
            category: parseNonNegativeInteger(fields[14], `item[${id}].category`),
            sale_price: parseNonNegativeInteger(fields[16], `item[${id}].salePrice`),
            sellable: parseBoolean(fields[21], `item[${id}].sellable`),
        }
    }
    return { data, ids, lookup, maxCount, sale }
}

export async function convertItemEquipmentTables(
    reader: ItemEquipmentSourceReader,
    compatibility: ItemEquipmentConversionCompatibility = { equipmentLookup: {} },
): Promise<ItemEquipmentConversionOutput> {
    const [equipmentRows, craftRows, dissolveRateRows, itemRows, itemBonusSelectRows] = await Promise.all([
        reader.read(EQUIPMENT_PATH),
        reader.read(EQUIPMENT_CRAFT_PATH),
        reader.read(EQUIPMENT_DISSOLVE_RATE_PATH),
        reader.read(ITEM_PATH),
        reader.read(ITEM_BONUS_SELECT_PATH),
    ])
    const equipment = convertEquipment(equipmentRows, compatibility)
    const items = convertItems(itemRows, convertItemBonusSelect(itemBonusSelectRows))
    return deepFreeze({
        "equipment_craft.json": convertEquipmentCraft(craftRows, dissolveRateRows),
        "equipment_dissolve.json": equipment.dissolve,
        "equipment_ids.json": equipment.ids,
        "equipment_lookup.json": equipment.lookup,
        "item_data.json": items.data,
        "item_ids.json": items.ids,
        "item_lookup.json": items.lookup,
        "item_max_count.json": items.maxCount,
        "item_sale.json": items.sale,
    })
}
