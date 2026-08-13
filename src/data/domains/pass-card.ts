import { getDb } from "../db"

export interface PlayerPassCardState {
    eventId: number
    point: number
    isBuy: boolean
    loginBaseline?: number
}

export interface PlayerPassCardRewardRecord {
    rewardId: number
    isReceived1: number
    isReceived2: number
}

export function getPlayerPassCardStateSync(
    playerId: number,
    eventId: number,
): PlayerPassCardState {
    const row = getDb().prepare(`
        SELECT event_id, point, is_buy, login_baseline
        FROM players_pass_cards
        WHERE player_id = ? AND event_id = ?
    `).get(playerId, eventId) as {
        event_id: number
        point: number
        is_buy: number
        login_baseline: number | null
    } | undefined

    return {
        eventId,
        point: row?.point ?? 0,
        isBuy: row?.is_buy === 1,
        ...(row?.login_baseline === null || row?.login_baseline === undefined
            ? {}
            : { loginBaseline: row.login_baseline }),
    }
}

export function setPlayerPassCardPurchasedSync(
    playerId: number,
    eventId: number,
): void {
    getDb().prepare(`
        INSERT INTO players_pass_cards (player_id, event_id, point, is_buy, login_baseline)
        VALUES (?, ?, 0, 1, NULL)
        ON CONFLICT(player_id, event_id) DO UPDATE SET
            is_buy = 1
    `).run(playerId, eventId)
}

export function ensurePlayerPassCardLoginProgressSync(
    playerId: number,
    eventId: number,
    totalLoginDays: number,
): number {
    const initialBaseline = Math.max(0, totalLoginDays - 1)
    const row = getDb().prepare(`
        INSERT INTO players_pass_cards (player_id, event_id, point, is_buy, login_baseline)
        VALUES (?, ?, 0, 1, ?)
        ON CONFLICT(player_id, event_id) DO UPDATE SET
            is_buy = 1,
            login_baseline = COALESCE(login_baseline, excluded.login_baseline)
        RETURNING login_baseline
    `).get(playerId, eventId, initialBaseline) as { login_baseline: number }
    return Math.max(0, totalLoginDays - row.login_baseline)
}

export function addPlayerPassCardPointSync(
    playerId: number,
    eventId: number,
    amount: number,
    maxPoint: number = Number.MAX_SAFE_INTEGER,
): number {
    if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new TypeError("Pass point amount must be a non-negative safe integer.")
    }
    if (!Number.isSafeInteger(maxPoint) || maxPoint < 0) {
        throw new TypeError("Pass point limit must be a non-negative safe integer.")
    }
    const cappedAmount = Math.min(amount, maxPoint)
    const row = getDb().prepare(`
        INSERT INTO players_pass_cards (player_id, event_id, point, is_buy, login_baseline)
        VALUES (?, ?, ?, 0, NULL)
        ON CONFLICT(player_id, event_id) DO UPDATE SET
            point = MIN(point + excluded.point, ?)
        RETURNING point
    `).get(playerId, eventId, cappedAmount, maxPoint) as { point: number }
    return row.point
}

export function getPlayerPassCardRewardRecordsSync(
    playerId: number,
    eventId: number,
): PlayerPassCardRewardRecord[] {
    const rows = getDb().prepare(`
        SELECT reward_id, is_received_1, is_received_2
        FROM players_pass_card_rewards
        WHERE player_id = ? AND event_id = ?
        ORDER BY reward_id
    `).all(playerId, eventId) as Array<{
        reward_id: number
        is_received_1: number
        is_received_2: number
    }>
    return rows.map(row => ({
        rewardId: row.reward_id,
        isReceived1: row.is_received_1,
        isReceived2: row.is_received_2,
    }))
}

export function setPlayerPassCardRewardReceivedSync(
    playerId: number,
    eventId: number,
    rewardId: number,
    receive1: boolean,
    receive2: boolean,
): void {
    getDb().prepare(`
        INSERT INTO players_pass_card_rewards (
            player_id, event_id, reward_id, is_received_1, is_received_2
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(player_id, event_id, reward_id) DO UPDATE SET
            is_received_1 = MAX(is_received_1, excluded.is_received_1),
            is_received_2 = MAX(is_received_2, excluded.is_received_2)
    `).run(playerId, eventId, rewardId, receive1 ? 1 : 0, receive2 ? 1 : 0)
}
