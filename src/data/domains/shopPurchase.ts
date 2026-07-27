import { getDb } from "../db";

export interface ShopPurchaseCount {
    shopItemId: number
    count: number
}

export interface ShopPurchasePeriodKeys {
    readonly daily: string
    readonly monthly: string
}

export interface ShopPurchasePeriodCounts {
    readonly daily: number
    readonly monthly: number
    readonly total: number
}

function getCounterSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    periodType: "daily" | "monthly" | "total",
    periodKey: string,
): number | null {
    const row = getDb().prepare(`
        SELECT count FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_type = ? AND shop_item_id = ?
          AND period_type = ? AND period_key = ?
    `).get(playerId, shopType, shopItemId, periodType, periodKey) as { count: number } | undefined
    return row?.count ?? null
}

export function getPlayerShopPurchaseCountsByTypeSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    keys: ShopPurchasePeriodKeys,
): ShopPurchasePeriodCounts {
    const exactTotal = getCounterSync(playerId, shopType, shopItemId, "total", "")
    const legacyTotal = exactTotal === null
        ? getCounterSync(playerId, -1, shopItemId, "total", "")
        : null
    return {
        daily: getCounterSync(playerId, shopType, shopItemId, "daily", keys.daily) ?? 0,
        monthly: getCounterSync(playerId, shopType, shopItemId, "monthly", keys.monthly) ?? 0,
        total: exactTotal ?? legacyTotal ?? 0,
    }
}

export function addPlayerShopPurchaseCountsByTypeSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    amount: number,
    keys: ShopPurchasePeriodKeys,
): ShopPurchasePeriodCounts {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error("Shop purchase count increment must be a positive integer.")
    }
    const database = getDb()
    const addCounter = (
        periodType: "daily" | "monthly" | "total",
        periodKey: string,
        increment: number,
    ) => database.prepare(`
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, shop_type, shop_item_id, period_type, period_key)
        DO UPDATE SET count = count + excluded.count
    `).run(playerId, shopType, shopItemId, periodType, periodKey, increment)

    const exactTotal = getCounterSync(playerId, shopType, shopItemId, "total", "")
    if (exactTotal === null) {
        const legacyTotal = getCounterSync(playerId, -1, shopItemId, "total", "") ?? 0
        if (legacyTotal > 0) {
            addCounter("total", "", legacyTotal)
            database.prepare(`
                DELETE FROM players_shop_purchase_counters
                WHERE player_id = ? AND shop_type = -1 AND shop_item_id = ?
                  AND period_type = 'total' AND period_key = ''
            `).run(playerId, shopItemId)
            database.prepare(`
                DELETE FROM players_shop_purchases
                WHERE player_id = ? AND shop_item_id = ?
            `).run(playerId, shopItemId)
        }
    }
    addCounter("daily", keys.daily, amount)
    addCounter("monthly", keys.monthly, amount)
    addCounter("total", "", amount)
    return getPlayerShopPurchaseCountsByTypeSync(playerId, shopType, shopItemId, keys)
}

export function getPlayerShopPurchasesSync(playerId: number): ShopPurchaseCount[] {
    const rows = getDb().prepare(`
        SELECT shop_item_id, count
        FROM players_shop_purchases
        WHERE player_id = ?
    `).all(playerId) as { shop_item_id: number, count: number }[]

    return rows.map(r => ({ shopItemId: r.shop_item_id, count: r.count }))
}

export function getPlayerShopPurchasesMapSync(
    playerId: number,
    shopType?: number,
): Record<number, number> {
    const map: Record<number, number> = {}
    const rows = (shopType === undefined
        ? getDb().prepare(`
            SELECT shop_item_id, SUM(count) AS count
            FROM players_shop_purchase_counters
            WHERE player_id = ? AND period_type = 'total' AND period_key = ''
              AND shop_type >= 0
            GROUP BY shop_item_id
        `).all(playerId)
        : getDb().prepare(`
            SELECT shop_item_id, count
            FROM players_shop_purchase_counters
            WHERE player_id = ? AND shop_type = ?
              AND period_type = 'total' AND period_key = ''
        `).all(playerId, shopType)) as { shop_item_id: number, count: number }[]
    for (const row of rows) map[row.shop_item_id] = row.count

    const legacyRows = getDb().prepare(`
        SELECT shop_item_id, count
        FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_type = -1
          AND period_type = 'total' AND period_key = ''
    `).all(playerId) as { shop_item_id: number, count: number }[]
    for (const row of legacyRows) {
        if (map[row.shop_item_id] === undefined) map[row.shop_item_id] = row.count
    }
    return map
}

export function getPlayerShopPurchaseCountSync(playerId: number, shopItemId: number): number {
    const row = getDb().prepare(`
        SELECT count FROM players_shop_purchases
        WHERE player_id = ? AND shop_item_id = ?
    `).get(playerId, shopItemId) as { count: number } | undefined
    return row?.count ?? 0
}

export function addPlayerShopPurchaseSync(playerId: number, shopItemId: number): number {
    return addPlayerShopPurchaseCountSync(playerId, shopItemId, 1)
}

export function addPlayerShopPurchaseCountSync(
    playerId: number,
    shopItemId: number,
    amount: number,
): number {
    getDb().prepare(`
        INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
        VALUES (?, ?, ?)
        ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
    `).run(playerId, shopItemId, amount)

    getDb().prepare(`
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        ) VALUES (?, -1, ?, 'total', '', ?)
        ON CONFLICT(player_id, shop_type, shop_item_id, period_type, period_key)
        DO UPDATE SET count = count + excluded.count
    `).run(playerId, shopItemId, amount)

    return getPlayerShopPurchaseCountSync(playerId, shopItemId)
}
