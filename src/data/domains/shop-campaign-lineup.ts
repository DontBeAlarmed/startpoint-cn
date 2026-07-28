import { clientSerializeDate } from "../utils"
import { getDb } from "../db"

interface RawShopCampaignLineup {
    lineup_id: number
}

export type ShopCampaignLineupSelectionResult = "inserted" | "unchanged" | "conflict"

export function getPlayerShopCampaignLineupSync(
    playerId: number,
    shopType: number,
    campaignId: number,
): number | null {
    const row = getDb().prepare(`
        SELECT lineup_id
        FROM players_shop_campaign_lineups
        WHERE player_id = ? AND shop_type = ? AND campaign_id = ?
    `).get(playerId, shopType, campaignId) as RawShopCampaignLineup | undefined
    return row?.lineup_id ?? null
}

export function getPlayerShopCampaignLineupsSync(playerId: number): Record<string, number> {
    const rows = getDb().prepare(`
        SELECT shop_type, campaign_id, lineup_id
        FROM players_shop_campaign_lineups
        WHERE player_id = ?
        ORDER BY shop_type, campaign_id
    `).all(playerId) as Array<{
        shop_type: number
        campaign_id: number
        lineup_id: number
    }>
    return Object.fromEntries(rows.map(row => [
        `${row.shop_type}:${row.campaign_id}`,
        row.lineup_id,
    ]))
}

export function selectPlayerShopCampaignLineupSync(
    playerId: number,
    shopType: number,
    campaignId: number,
    lineupId: number,
    selectedAt: Date = new Date(),
): ShopCampaignLineupSelectionResult {
    const inserted = getDb().prepare(`
        INSERT OR IGNORE INTO players_shop_campaign_lineups (
            player_id, shop_type, campaign_id, lineup_id, selected_at
        ) VALUES (?, ?, ?, ?, ?)
    `).run(
        playerId,
        shopType,
        campaignId,
        lineupId,
        clientSerializeDate(selectedAt),
    ).changes === 1
    if (inserted) return "inserted"
    return getPlayerShopCampaignLineupSync(playerId, shopType, campaignId) === lineupId
        ? "unchanged"
        : "conflict"
}
