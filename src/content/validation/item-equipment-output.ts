import { deepFreeze } from "../deep-freeze"
import {
    invalidRuntimeTable,
    requireArray,
    requireBoolean,
    requireCanonicalPositiveIntegerArray,
    requireCanonicalPositiveIntegerKey,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    requireRecord,
} from "./runtime-table"

export interface ValidatedItemContentTables {
    readonly effects: Readonly<Record<string, unknown>>
    readonly ids: readonly number[]
    readonly lookup: Readonly<Record<string, string>>
    readonly sale: Readonly<Record<string, unknown>>
}

export interface ValidatedEquipmentContentTables {
    readonly craftByRarity: Readonly<Record<string, unknown>>
    readonly dissolveById: Readonly<Record<string, unknown>>
    readonly ids: readonly number[]
    readonly lookup: Readonly<Record<string, unknown>>
}

function assertExactIdSet(
    tableName: string,
    subject: string,
    expectedIds: ReadonlySet<number>,
    actualKeys: readonly string[],
): void {
    const actualIds = new Set(actualKeys.map(key => (
        requireCanonicalPositiveIntegerKey(key, tableName, `${subject} key`)
    )))
    if (actualIds.size !== expectedIds.size
        || [...expectedIds].some(id => !actualIds.has(id))) {
        invalidRuntimeTable(tableName, `${subject} ids must exactly match the canonical id list`)
    }
}

export function validateItemContentTables(input: {
    readonly effects: unknown
    readonly ids: unknown
    readonly lookup: unknown
    readonly sale: unknown
}): ValidatedItemContentTables {
    const tableName = "item catalog"
    const ids = requireCanonicalPositiveIntegerArray(input.ids, tableName, "item_ids")
    if (ids.length === 0) invalidRuntimeTable(tableName, "item_ids must not be empty")
    const idSet = new Set(ids)
    const lookup = requireRecord(input.lookup, tableName, "item_lookup")
    const sale = requireRecord(input.sale, tableName, "item_sale")
    const effects = requireRecord(input.effects, tableName, "item_data")

    assertExactIdSet(tableName, "item_lookup", idSet, Object.keys(lookup))
    assertExactIdSet(tableName, "item_sale", idSet, Object.keys(sale))

    for (const [idText, name] of Object.entries(lookup)) {
        requireNonEmptyString(name, tableName, `item_lookup[${idText}]`)
    }
    for (const [idText, raw] of Object.entries(sale)) {
        const row = requireRecord(raw, tableName, `item_sale[${idText}]`)
        requireNonNegativeSafeInteger(row.category, tableName, `item_sale[${idText}].category`)
        requireNonNegativeSafeInteger(row.sale_price, tableName, `item_sale[${idText}].sale_price`)
        requireBoolean(row.sellable, tableName, `item_sale[${idText}].sellable`)
    }
    for (const [idText, raw] of Object.entries(effects)) {
        const id = requireCanonicalPositiveIntegerKey(idText, tableName, "item_data key")
        if (!idSet.has(id)) invalidRuntimeTable(tableName, `item_data references unknown item ${id}`)
        const row = requireRecord(raw, tableName, `item_data[${idText}]`)
        if (row.effectKind === 2 || row.effectKind === 3) {
            requirePositiveSafeInteger(
                row.effectValue,
                tableName,
                `item_data[${idText}].effectValue`,
            )
            continue
        }
        if (row.effectKind !== 22 || row.effectValue !== 0) {
            invalidRuntimeTable(tableName, `item_data[${idText}] has an unsupported effect`)
        }
        const rewards = requireArray(
            row.selectRewards,
            tableName,
            `item_data[${idText}].selectRewards`,
        )
        if (rewards.length === 0) {
            invalidRuntimeTable(tableName, `item_data[${idText}].selectRewards must not be empty`)
        }
        const selectedItemIds = new Set<number>()
        rewards.forEach((reward, index) => {
            const rewardRow = requireRecord(
                reward,
                tableName,
                `item_data[${idText}].selectRewards[${index}]`,
            )
            const itemId = requirePositiveSafeInteger(
                rewardRow.itemId,
                tableName,
                `item_data[${idText}].selectRewards[${index}].itemId`,
            )
            if (!idSet.has(itemId)) {
                invalidRuntimeTable(tableName, `item_data[${idText}] references unknown item ${itemId}`)
            }
            if (selectedItemIds.has(itemId)) {
                invalidRuntimeTable(tableName, `item_data[${idText}] has duplicate selected item ${itemId}`)
            }
            selectedItemIds.add(itemId)
            requirePositiveSafeInteger(
                rewardRow.amount,
                tableName,
                `item_data[${idText}].selectRewards[${index}].amount`,
            )
        })
    }
    return deepFreeze({ effects, ids, lookup, sale }) as ValidatedItemContentTables
}

export function validateEquipmentContentTables(input: {
    readonly craftByRarity: unknown
    readonly dissolveById: unknown
    readonly ids: unknown
    readonly lookup: unknown
}): ValidatedEquipmentContentTables {
    const tableName = "equipment catalog"
    const ids = requireCanonicalPositiveIntegerArray(input.ids, tableName, "equipment_ids")
    if (ids.length === 0) invalidRuntimeTable(tableName, "equipment_ids must not be empty")
    const idSet = new Set(ids)
    const craftByRarity = requireRecord(input.craftByRarity, tableName, "equipment_craft")
    const dissolveById = requireRecord(input.dissolveById, tableName, "equipment_dissolve")
    const lookup = requireRecord(input.lookup, tableName, "equipment_lookup")

    assertExactIdSet(tableName, "equipment_dissolve", idSet, Object.keys(dissolveById))
    assertExactIdSet(tableName, "equipment_lookup", idSet, Object.keys(lookup))

    const craftRarities = new Set<number>()
    for (const [rarityText, raw] of Object.entries(craftByRarity)) {
        const rarity = requireCanonicalPositiveIntegerKey(
            rarityText,
            tableName,
            "equipment_craft rarity",
        )
        craftRarities.add(rarity)
        const row = requireRecord(raw, tableName, `equipment_craft[${rarityText}]`)
        for (const field of ["dissolve_craft", "awakening_craft", "dissolve_star"] as const) {
            requireNonNegativeSafeInteger(
                row[field],
                tableName,
                `equipment_craft[${rarityText}].${field}`,
            )
        }
    }
    if (craftRarities.size === 0) {
        invalidRuntimeTable(tableName, "equipment_craft must not be empty")
    }

    for (const [idText, raw] of Object.entries(dissolveById)) {
        const row = requireRecord(raw, tableName, `equipment_dissolve[${idText}]`)
        requirePositiveSafeInteger(
            row.ability_soul_id,
            tableName,
            `equipment_dissolve[${idText}].ability_soul_id`,
        )
        requireNonNegativeSafeInteger(
            row.obtain_source,
            tableName,
            `equipment_dissolve[${idText}].obtain_source`,
        )
        requireBoolean(
            row.generate_ability_soul,
            tableName,
            `equipment_dissolve[${idText}].generate_ability_soul`,
        )
        requirePositiveSafeInteger(
            row.max_level,
            tableName,
            `equipment_dissolve[${idText}].max_level`,
        )
    }
    for (const [idText, raw] of Object.entries(lookup)) {
        const row = requireRecord(raw, tableName, `equipment_lookup[${idText}]`)
        requireNonEmptyString(row.name, tableName, `equipment_lookup[${idText}].name`)
        requireNonEmptyString(row.category, tableName, `equipment_lookup[${idText}].category`)
        const rarityText = requireNonEmptyString(
            row.rarity,
            tableName,
            `equipment_lookup[${idText}].rarity`,
        )
        const rarity = requireCanonicalPositiveIntegerKey(
            rarityText,
            tableName,
            `equipment_lookup[${idText}].rarity`,
        )
        if (!craftRarities.has(rarity)) {
            invalidRuntimeTable(tableName, `equipment ${idText} references missing craft rarity ${rarity}`)
        }
        // The client/server upgrade and dissolve paths derive rarity from the
        // million-place prefix for actual equipment IDs. Main-story orbs,
        // medals, and non-equipment records use a separate sub-million ID
        // namespace and are intentionally exempt from that relation.
        const id = Number(idText)
        if (id >= 1_000_000 && Math.floor(id / 1_000_000) !== rarity) {
            invalidRuntimeTable(
                tableName,
                `equipment ${idText} rarity must match its id prefix`,
            )
        }
    }
    return deepFreeze({ craftByRarity, dissolveById, ids, lookup })
}
