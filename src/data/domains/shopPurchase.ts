import { getDb } from "../db";

export interface ShopPurchaseCount {
    shopItemId: number
    count: number
}

export function getPlayerShopPurchasesSync(playerId: number): ShopPurchaseCount[] {
    const rows = getDb().prepare(`
        SELECT shop_item_id, count
        FROM players_shop_purchases
        WHERE player_id = ?
    `).all(playerId) as { shop_item_id: number, count: number }[]

    return rows.map(r => ({ shopItemId: r.shop_item_id, count: r.count }))
}

export function getPlayerShopPurchasesMapSync(playerId: number): Record<number, number> {
    const map: Record<number, number> = {}
    const rows = getPlayerShopPurchasesSync(playerId)
    for (const r of rows) {
        map[r.shopItemId] = r.count
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

    return getPlayerShopPurchaseCountSync(playerId, shopItemId)
}
