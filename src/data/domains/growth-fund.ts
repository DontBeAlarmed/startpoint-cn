import { getDb } from "../db"

// 成长基金已领取 bonus（fund_receive_list）。
// 购买身份是 user_info 的恒真布尔（2026-10-29 裁定），这里只持久化领取事实。

export function getPlayerGrowthFundReceivedIdsSync(playerId: number): number[] {
    const rows = getDb().prepare(`
    SELECT bonus_id
    FROM players_growth_fund_received
    WHERE player_id = ?
    ORDER BY bonus_id
    `).all(playerId) as { bonus_id: number }[]
    return rows.map(row => row.bonus_id)
}

export function insertPlayerGrowthFundReceivedSync(playerId: number, bonusId: number): void {
    getDb().prepare(`
    INSERT OR IGNORE INTO players_growth_fund_received (bonus_id, player_id)
    VALUES (?, ?)
    `).run(bonusId, playerId)
}

export function insertPlayerGrowthFundReceivedBatchSync(
    playerId: number,
    bonusIds: readonly number[],
): void {
    getDb().transaction(() => {
        for (const bonusId of bonusIds) {
            insertPlayerGrowthFundReceivedSync(playerId, bonusId)
        }
    })()
}

export function deletePlayerGrowthFundReceivedSync(playerId: number): void {
    getDb().prepare(`
    DELETE FROM players_growth_fund_received
    WHERE player_id = ?
    `).run(playerId)
}
