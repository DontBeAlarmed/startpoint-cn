import type { NestedOrderedMapTextRows } from "../../sync/ordered-map"
import type {
    ShopCostItemScheduleRows,
} from "../../../lib/types/shop"
import {
    invalidShop,
    parseOptionalShopDate,
    parseShopCosts,
    parseShopDate,
    parseShopInteger,
    requireShopRows,
} from "./parser"

const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_]+$/

export function convertShopCostItemSchedules(
    groups: readonly NestedOrderedMapTextRows[],
): ShopCostItemScheduleRows {
    const output: ShopCostItemScheduleRows = {}
    for (const group of [...groups].sort((left, right) => left.key.localeCompare(right.key))) {
        if (!SCHEDULE_ID_PATTERN.test(group.key) || output[group.key] !== undefined) {
            invalidShop(`shop_cost_item_schedule has invalid or duplicate group ${group.key}`)
        }
        const rows = requireShopRows(
            group.rows,
            `shop_cost_item_schedule[${group.key}]`,
            11,
        ).map(([key, fields]) => {
            const subject = `shop_cost_item_schedule[${group.key}][${key}]`
            const month = parseShopInteger(fields[2], `${subject}.month`)
            if (month < 1 || month > 12 || Number(key) !== month) {
                invalidShop(`${subject}.month must match key and be 1 through 12`)
            }
            const costs = parseShopCosts(fields, [3, 5, 7, 9], subject)
            if (costs.length === 0) invalidShop(`${subject}.costs must not be empty`)
            return {
                availableFrom: parseShopDate(fields[0], `${subject}.availableFrom`),
                availableUntil: parseOptionalShopDate(fields[1], `${subject}.availableUntil`),
                month,
                costs,
            }
        })
        output[group.key] = rows
    }
    return output
}
