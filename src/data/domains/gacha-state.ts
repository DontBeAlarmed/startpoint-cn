import { getDb } from "../db"
import type {
    PlayerGachaDetail,
    PlayerStarsGachaCampaign,
    RawPlayerGachaDetail,
    RawPlayerStarsGachaCampaign,
} from "../types"

function positiveInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value as number
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value as number
}

function period(startTime: unknown, endTime: unknown): readonly [number, number] {
    const start = nonNegativeInteger(startTime, "periodStartTime")
    const end = nonNegativeInteger(endTime, "periodEndTime")
    if (start > end) throw new TypeError("Gacha player period is reversed")
    return [start, end]
}

function detailFromRaw(raw: RawPlayerGachaDetail): PlayerGachaDetail {
    return {
        gachaId: raw.gacha_id,
        dailyOneCount: raw.daily_one_count,
        dailyTenCount: raw.daily_ten_count,
        comebackPeriodStartTime: raw.comeback_period_start_time,
        comebackPeriodEndTime: raw.comeback_period_end_time,
    }
}

function starsFromRaw(raw: RawPlayerStarsGachaCampaign): PlayerStarsGachaCampaign {
    return {
        campaignId: raw.campaign_id,
        gachaId: raw.gacha_id,
        periodStartTime: raw.period_start_time,
        periodEndTime: raw.period_end_time,
        freeOneTimes: raw.free_one_times,
        freeTenTimes: raw.free_ten_times,
    }
}

export function getPlayerGachaDetailSync(
    playerId: number,
    gachaId: number,
): PlayerGachaDetail | null {
    const raw = getDb().prepare(`
        SELECT gacha_id, daily_one_count, daily_ten_count,
            comeback_period_start_time, comeback_period_end_time
        FROM players_gacha_details
        WHERE player_id = ? AND gacha_id = ?
    `).get(playerId, gachaId) as RawPlayerGachaDetail | undefined
    return raw === undefined ? null : detailFromRaw(raw)
}

export function getPlayerGachaDetailListSync(playerId: number): PlayerGachaDetail[] {
    return (getDb().prepare(`
        SELECT gacha_id, daily_one_count, daily_ten_count,
            comeback_period_start_time, comeback_period_end_time
        FROM players_gacha_details
        WHERE player_id = ?
        ORDER BY gacha_id
    `).all(playerId) as RawPlayerGachaDetail[]).map(detailFromRaw)
}

export function getPlayerStarsGachaCampaignByGachaSync(
    playerId: number,
    gachaId: number,
): PlayerStarsGachaCampaign | null {
    const raw = getDb().prepare(`
        SELECT campaign_id, gacha_id, period_start_time, period_end_time,
            free_one_times, free_ten_times
        FROM players_stars_gacha_campaigns
        WHERE player_id = ? AND gacha_id = ?
    `).get(playerId, gachaId) as RawPlayerStarsGachaCampaign | undefined
    return raw === undefined ? null : starsFromRaw(raw)
}

export function getPlayerStarsGachaCampaignListSync(
    playerId: number,
): PlayerStarsGachaCampaign[] {
    return (getDb().prepare(`
        SELECT campaign_id, gacha_id, period_start_time, period_end_time,
            free_one_times, free_ten_times
        FROM players_stars_gacha_campaigns
        WHERE player_id = ?
        ORDER BY campaign_id
    `).all(playerId) as RawPlayerStarsGachaCampaign[]).map(starsFromRaw)
}

export function updatePlayerStarsGachaCampaignCountsSync(input: {
    readonly playerId: number
    readonly campaignId: number
    readonly gachaId: number
    readonly freeOneTimes: number
    readonly freeTenTimes: number
}): void {
    nonNegativeInteger(input.freeOneTimes, "freeOneTimes")
    nonNegativeInteger(input.freeTenTimes, "freeTenTimes")
    const result = getDb().prepare(`
        UPDATE players_stars_gacha_campaigns
        SET free_one_times = ?, free_ten_times = ?
        WHERE player_id = ? AND campaign_id = ? AND gacha_id = ?
    `).run(
        input.freeOneTimes,
        input.freeTenTimes,
        input.playerId,
        input.campaignId,
        input.gachaId,
    )
    if (result.changes !== 1) throw new Error("Stars Gacha count update did not write")
}

function ensureBaseGachaInfoSync(playerId: number, gachaId: number): void {
    getDb().prepare(`
        INSERT INTO players_gacha_info (
            gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id
        ) VALUES (?, 1, 1, 0, ?)
        ON CONFLICT(gacha_id, player_id) DO NOTHING
    `).run(gachaId, playerId)
}

export function upsertPlayerComebackGachaPeriodSync(input: {
    readonly playerId: number
    readonly gachaId: number
    readonly periodStartTime: number
    readonly periodEndTime: number
}): void {
    positiveInteger(input.playerId, "playerId")
    positiveInteger(input.gachaId, "gachaId")
    const [start, end] = period(input.periodStartTime, input.periodEndTime)
    ensureBaseGachaInfoSync(input.playerId, input.gachaId)
    getDb().prepare(`
        INSERT INTO players_gacha_details (
            player_id, gacha_id, comeback_period_start_time, comeback_period_end_time
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id, gacha_id) DO UPDATE SET
            comeback_period_start_time = excluded.comeback_period_start_time,
            comeback_period_end_time = excluded.comeback_period_end_time
    `).run(input.playerId, input.gachaId, start, end)
}

export function upsertPlayerGachaDetailSync(input: PlayerGachaDetail & {
    readonly playerId: number
}): void {
    positiveInteger(input.playerId, "playerId")
    positiveInteger(input.gachaId, "gachaId")
    if ((input.comebackPeriodStartTime === null) !== (input.comebackPeriodEndTime === null)) {
        throw new TypeError("Comeback Gacha period must be fully present or absent")
    }
    if (input.comebackPeriodStartTime !== null) {
        period(input.comebackPeriodStartTime, input.comebackPeriodEndTime)
    }
    if (input.dailyOneCount !== null) nonNegativeInteger(input.dailyOneCount, "dailyOneCount")
    if (input.dailyTenCount !== null) nonNegativeInteger(input.dailyTenCount, "dailyTenCount")
    ensureBaseGachaInfoSync(input.playerId, input.gachaId)
    getDb().prepare(`
        INSERT INTO players_gacha_details (
            player_id, gacha_id, daily_one_count, daily_ten_count,
            comeback_period_start_time, comeback_period_end_time
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, gacha_id) DO UPDATE SET
            daily_one_count = excluded.daily_one_count,
            daily_ten_count = excluded.daily_ten_count,
            comeback_period_start_time = excluded.comeback_period_start_time,
            comeback_period_end_time = excluded.comeback_period_end_time
    `).run(
        input.playerId,
        input.gachaId,
        input.dailyOneCount,
        input.dailyTenCount,
        input.comebackPeriodStartTime,
        input.comebackPeriodEndTime,
    )
}

export function upsertPlayerStarsGachaCampaignSync(input: PlayerStarsGachaCampaign & {
    readonly playerId: number
}): void {
    positiveInteger(input.playerId, "playerId")
    positiveInteger(input.campaignId, "campaignId")
    positiveInteger(input.gachaId, "gachaId")
    const [start, end] = period(input.periodStartTime, input.periodEndTime)
    nonNegativeInteger(input.freeOneTimes, "freeOneTimes")
    nonNegativeInteger(input.freeTenTimes, "freeTenTimes")
    ensureBaseGachaInfoSync(input.playerId, input.gachaId)
    getDb().prepare(`
        INSERT INTO players_stars_gacha_campaigns (
            player_id, campaign_id, gacha_id, period_start_time, period_end_time,
            free_one_times, free_ten_times
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, campaign_id) DO UPDATE SET
            gacha_id = excluded.gacha_id,
            period_start_time = excluded.period_start_time,
            period_end_time = excluded.period_end_time,
            free_one_times = excluded.free_one_times,
            free_ten_times = excluded.free_ten_times
    `).run(
        input.playerId,
        input.campaignId,
        input.gachaId,
        start,
        end,
        input.freeOneTimes,
        input.freeTenTimes,
    )
}

export function resetPlayerGachaDailyStateSync(playerId: number): void {
    positiveInteger(playerId, "playerId")
    const db = getDb()
    db.prepare(`UPDATE players_gacha_info SET is_daily_first = 1
        WHERE player_id = ? AND is_daily_first <> 1`).run(playerId)
    db.prepare(`UPDATE players_gacha_details
        SET daily_one_count = CASE WHEN daily_one_count IS NULL THEN NULL ELSE 0 END,
            daily_ten_count = CASE WHEN daily_ten_count IS NULL THEN NULL ELSE 0 END
        WHERE player_id = ? AND (
            COALESCE(daily_one_count, 0) <> 0 OR COALESCE(daily_ten_count, 0) <> 0
        )`).run(playerId)
    db.prepare(`UPDATE players_gacha_campaigns SET count = 1
        WHERE player_id = ? AND count <> 1`).run(playerId)
}
