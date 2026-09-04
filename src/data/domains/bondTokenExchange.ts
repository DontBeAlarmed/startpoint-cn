import { getDb } from "../db";

export interface BondTokenExchangeCount {
    equipmentId: number
    exchangeCount: number
}

function nonNegativeSafeInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Bond token exchange ${subject} is invalid`)
    }
    return value as number
}

function positiveSafeInteger(value: unknown, subject: string): number {
    const parsed = nonNegativeSafeInteger(value, subject)
    if (parsed === 0) throw new Error(`Bond token exchange ${subject} is invalid`)
    return parsed
}

export function getPlayerBondTokenExchangeCountSync(
    playerId: number,
    equipmentId: number,
): number {
    const row = getDb().prepare(`
        SELECT exchange_count FROM players_bond_token_exchanges
        WHERE player_id = ? AND equipment_id = ?
    `).get(playerId, equipmentId) as { exchange_count: number } | undefined
    return row === undefined
        ? 0
        : nonNegativeSafeInteger(row.exchange_count, "count")
}

export function listPlayerBondTokenExchangeCountsSync(playerId: number): readonly BondTokenExchangeCount[] {
    const rows = getDb().prepare(`
        SELECT equipment_id, exchange_count FROM players_bond_token_exchanges
        WHERE player_id = ?
    `).all(playerId) as Array<{ equipment_id: number; exchange_count: number }>
    return rows.map(row => ({
        equipmentId: positiveSafeInteger(row.equipment_id, "equipment id"),
        exchangeCount: nonNegativeSafeInteger(row.exchange_count, "count"),
    }))
}

export function recordPlayerBondTokenExchangeSync(
    playerId: number,
    equipmentId: number,
): number {
    const result = getDb().prepare(`
        INSERT INTO players_bond_token_exchanges (player_id, equipment_id, exchange_count)
        VALUES (?, ?, 1)
        ON CONFLICT(player_id, equipment_id) DO UPDATE SET exchange_count = exchange_count + 1
        RETURNING exchange_count
    `).get(playerId, equipmentId) as { exchange_count: number }
    return nonNegativeSafeInteger(result.exchange_count, "recorded count")
}
