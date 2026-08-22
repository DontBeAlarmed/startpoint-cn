import { getDb } from "../db";

export interface ShopPurchaseCount {
    shopItemId: number
    count: number
}

export type ShopPurchaseMap = Readonly<Record<number, number>>

export interface ShopPurchasePeriodKeys {
    readonly daily: string
    readonly monthly: string
}

export interface ShopPurchasePeriodCounts {
    readonly daily: number
    readonly monthly: number
    readonly total: number
}

export interface ShopPurchaseQuery {
    readonly shopType: number
    readonly shopItemId: number
    readonly keys: ShopPurchasePeriodKeys
}

interface LegacyPurchaseMetadata {
    readonly counterExists: boolean
    readonly purchaseExists: boolean
}

const legacyPurchaseMetadata = Symbol("legacyPurchaseMetadata")

interface ShopPurchaseCountSnapshot extends ShopPurchasePeriodCounts {
    readonly [legacyPurchaseMetadata]?: LegacyPurchaseMetadata
}

export function getShopPurchaseQueryKey(query: ShopPurchaseQuery): string {
    return `${query.shopType}:${query.shopItemId}:${query.keys.daily}:${query.keys.monthly}`
}

function getCounterKey(
    shopType: number,
    shopItemId: number,
    periodType: "daily" | "monthly" | "total",
    periodKey: string,
): string {
    return `${shopType}:${shopItemId}:${periodType}:${periodKey}`
}

function createPurchaseCountSnapshot(
    daily: number,
    monthly: number,
    typedTotal: number,
    legacyCounter: number | undefined,
    legacyPurchase: number | undefined,
): ShopPurchaseCountSnapshot {
    const snapshot: ShopPurchaseCountSnapshot = {
        daily,
        monthly,
        total: typedTotal + resolveLegacyPurchaseTotal(legacyCounter, legacyPurchase),
    }
    Object.defineProperty(snapshot, legacyPurchaseMetadata, {
        value: {
            counterExists: legacyCounter !== undefined,
            purchaseExists: legacyPurchase !== undefined,
        } satisfies LegacyPurchaseMetadata,
    })
    return snapshot
}

function getPlayerShopPurchaseCountSnapshotSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    keys: ShopPurchasePeriodKeys,
): ShopPurchaseCountSnapshot {
    const rows = getDb().prepare(`
        SELECT shop_type, period_type, period_key, count
        FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_item_id = ? AND (
            (shop_type = ? AND (
                (period_type = 'daily' AND period_key = ?)
                OR (period_type = 'monthly' AND period_key = ?)
                OR (period_type = 'total' AND period_key = '')
            ))
            OR (shop_type = -1 AND period_type = 'total' AND period_key = '')
        )
    `).all(playerId, shopItemId, shopType, keys.daily, keys.monthly) as Array<{
        shop_type: number
        period_type: "daily" | "monthly" | "total"
        period_key: string
        count: number
    }>

    let daily = 0
    let monthly = 0
    let typedTotal = 0
    let legacyCounter: number | undefined
    for (const row of rows) {
        if (row.shop_type === -1) legacyCounter = row.count
        else if (row.period_type === "daily") daily = row.count
        else if (row.period_type === "monthly") monthly = row.count
        else typedTotal = row.count
    }
    const legacyPurchase = getDb().prepare(`
        SELECT count FROM players_shop_purchases
        WHERE player_id = ? AND shop_item_id = ?
    `).get(playerId, shopItemId) as { count: number } | undefined
    return createPurchaseCountSnapshot(
        daily,
        monthly,
        typedTotal,
        legacyCounter,
        legacyPurchase?.count,
    )
}

function resolveLegacyPurchaseTotal(
    legacyCounter: number | null | undefined,
    legacyPurchase: number | null | undefined,
): number {
    return Math.max(legacyCounter ?? 0, legacyPurchase ?? 0)
}

export function getPlayerShopPurchaseCountsByTypeSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    keys: ShopPurchasePeriodKeys,
): ShopPurchasePeriodCounts {
    const snapshot = getPlayerShopPurchaseCountSnapshotSync(
        playerId,
        shopType,
        shopItemId,
        keys,
    )
    return {
        daily: snapshot.daily,
        monthly: snapshot.monthly,
        total: snapshot.total,
    }
}

export function getPlayerShopPurchaseCountsByTypeBulkSync(
    playerId: number,
    queries: readonly ShopPurchaseQuery[],
): ReadonlyMap<string, ShopPurchasePeriodCounts> {
    if (queries.length === 0) return new Map()

    const rows = getDb().prepare(`
        SELECT shop_type, shop_item_id, period_type, period_key, count
        FROM players_shop_purchase_counters
        WHERE player_id = ?
    `).all(playerId) as Array<{
        shop_type: number
        shop_item_id: number
        period_type: "daily" | "monthly" | "total"
        period_key: string
        count: number
    }>
    const counters = new Map<string, number>()
    for (const row of rows) {
        counters.set(
            getCounterKey(row.shop_type, row.shop_item_id, row.period_type, row.period_key),
            row.count,
        )
    }
    const legacyRows = getDb().prepare(`
        SELECT shop_item_id, count
        FROM players_shop_purchases
        WHERE player_id = ?
    `).all(playerId) as Array<{ shop_item_id: number, count: number }>
    const legacyPurchases = new Map(
        legacyRows.map(row => [row.shop_item_id, row.count]),
    )

    return new Map(queries.map(query => {
        return [getShopPurchaseQueryKey(query), createPurchaseCountSnapshot(
            counters.get(
                getCounterKey(query.shopType, query.shopItemId, "daily", query.keys.daily),
            ) ?? 0,
            counters.get(
                getCounterKey(query.shopType, query.shopItemId, "monthly", query.keys.monthly),
            ) ?? 0,
            counters.get(getCounterKey(query.shopType, query.shopItemId, "total", "")) ?? 0,
            counters.get(getCounterKey(-1, query.shopItemId, "total", "")),
            legacyPurchases.get(query.shopItemId),
        )]
    }))
}

function writePlayerShopPurchaseCountSnapshotSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    amount: number,
    keys: ShopPurchasePeriodKeys,
    currentCounts: ShopPurchasePeriodCounts,
): ShopPurchasePeriodCounts {
    const finalCounts = {
        daily: currentCounts.daily + amount,
        monthly: currentCounts.monthly + amount,
        total: currentCounts.total + amount,
    }
    const database = getDb()
    const metadata = (currentCounts as ShopPurchaseCountSnapshot)[legacyPurchaseMetadata]
    if (metadata?.counterExists) {
        database.prepare(`
            DELETE FROM players_shop_purchase_counters
            WHERE player_id = ? AND shop_type = -1 AND shop_item_id = ?
              AND period_type = 'total' AND period_key = ''
        `).run(playerId, shopItemId)
    }
    if (metadata?.purchaseExists) {
        database.prepare(`
            DELETE FROM players_shop_purchases
            WHERE player_id = ? AND shop_item_id = ?
        `).run(playerId, shopItemId)
    }
    const setCounter = (
        periodType: "daily" | "monthly" | "total",
        periodKey: string,
        count: number,
    ) => database.prepare(`
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, shop_type, shop_item_id, period_type, period_key)
        DO UPDATE SET count = excluded.count
    `).run(playerId, shopType, shopItemId, periodType, periodKey, count)

    setCounter("daily", keys.daily, finalCounts.daily)
    setCounter("monthly", keys.monthly, finalCounts.monthly)
    setCounter("total", "", finalCounts.total)
    return finalCounts
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
    const snapshot = getPlayerShopPurchaseCountSnapshotSync(
        playerId,
        shopType,
        shopItemId,
        keys,
    )
    return writePlayerShopPurchaseCountSnapshotSync(
        playerId,
        shopType,
        shopItemId,
        amount,
        keys,
        snapshot,
    )
}

export function addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
    playerId: number,
    shopType: number,
    shopItemId: number,
    amount: number,
    keys: ShopPurchasePeriodKeys,
    currentCounts: ShopPurchasePeriodCounts,
): ShopPurchasePeriodCounts {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error("Shop purchase count increment must be a positive integer.")
    }
    return writePlayerShopPurchaseCountSnapshotSync(
        playerId,
        shopType,
        shopItemId,
        amount,
        keys,
        currentCounts,
    )
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
): ShopPurchaseMap {
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
