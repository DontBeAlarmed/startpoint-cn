import { getDb } from "../db";
import {
    PlayerPeriodicRewardPoint,
    PlayerStartDashExchangeCampaign,
    PlayerMultiSpecialExchangeCampaign,
    PlayerSpecialExchangeCampaign,
    RawPlayerStartDashExchangeCampaign,
    RawPlayerMultiSpecialExchangeCampaign,
    RawPlayerSpecialExchangeCampaign,
} from "../types";
import {
    getActivityPeriodicRewardPointDefinitions,
} from "../../lib/quest/periodic-reward-content";

// ─── Periodic Reward Points ───

function getStoredPlayerPeriodicRewardPointsSync(
    playerId: number,
): PlayerPeriodicRewardPoint[] {
    return getDb().prepare(`
    SELECT id, point
    FROM players_periodic_reward_points
    WHERE player_id = ?
    ORDER BY id
    `).all(playerId) as PlayerPeriodicRewardPoint[]
}

export function ensureActivityPeriodicRewardPointsSync(playerId: number): void {
    const existingIds = new Set(
        getStoredPlayerPeriodicRewardPointsSync(playerId).map(entry => entry.id),
    )
    const insert = getDb().prepare(`
    INSERT OR IGNORE INTO players_periodic_reward_points (id, point, player_id)
    VALUES (?, ?, ?)
    `)
    for (const { id, definition } of getActivityPeriodicRewardPointDefinitions()) {
        if (existingIds.has(id)) continue
        insert.run(id, definition.recoveryPoint, playerId)
    }
}

export function recoverActivityPeriodicRewardPointsSync(playerId: number): void {
    const definitions = new Map(getActivityPeriodicRewardPointDefinitions().map(
        ({ id, definition }) => [id, definition] as const,
    ))
    const existing = getStoredPlayerPeriodicRewardPointsSync(playerId)
    ensureActivityPeriodicRewardPointsSync(playerId)
    const update = getDb().prepare(`
    UPDATE players_periodic_reward_points
    SET point = ?
    WHERE player_id = ? AND id = ?
    `)
    for (const entry of existing) {
        const definition = definitions.get(entry.id)
        if (definition === undefined || definition.recoveryCycle !== 0) continue
        update.run(
            Math.min(definition.maxPoint, entry.point + definition.recoveryPoint),
            playerId,
            entry.id,
        )
    }
}

export function consumePeriodicRewardPointSync(
    playerId: number,
    periodicRewardPointId: number,
): number | null {
    const result = getDb().prepare(`
    UPDATE players_periodic_reward_points
    SET point = point - 1
    WHERE player_id = ? AND id = ? AND point > 0
    `).run(playerId, periodicRewardPointId)
    if (result.changes !== 1) return null
    const row = getDb().prepare(`
    SELECT point
    FROM players_periodic_reward_points
    WHERE player_id = ? AND id = ?
    `).get(playerId, periodicRewardPointId) as { point: number }
    return row.point
}

/**
 * Gets all of a player's periodic reward points.
 * 
 * @param playerId The ID of the player.
 * @returns A list of the player's periodic reward points
 */
export function getPlayerPeriodicRewardPointsSync(
    playerId: number
): PlayerPeriodicRewardPoint[] {
    ensureActivityPeriodicRewardPointsSync(playerId)
    return getStoredPlayerPeriodicRewardPointsSync(playerId)
}

function insertPlayerPeriodicRewardPointsSync(
    playerId: number,
    periodicReward: PlayerPeriodicRewardPoint
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_periodic_reward_points (id, point, player_id)
    VALUES (?, ?, ?)
    `).run(periodicReward.id, periodicReward.point, playerId)
}

export function insertPlayerPeriodicRewardPointsListSync(
    playerId: number,
    periodicRewards: PlayerPeriodicRewardPoint[]
) {
    const db = getDb();
    db.transaction(() => {
        for (const periodicReward of periodicRewards) {
            insertPlayerPeriodicRewardPointsSync(playerId, periodicReward)
        }
    })()
}

// ─── Start Dash Exchange Campaign ───

/**
 * Gets the progress of a player's start dash exchange campaigns.
 * 
 * @param playerId The player's ID.
 * @returns The status of the player's start dash exchange campaigns.
 */
export function getPlayerStartDashExchangeCampaignsSync(
    playerId: number
): PlayerStartDashExchangeCampaign[] {
    const db = getDb();
    const rawCampaigns = db.prepare(`
    SELECT campaign_id, gacha_id, term_index, status, period_start_time, period_end_time
    FROM players_start_dash_exchange_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawPlayerStartDashExchangeCampaign[]

    return rawCampaigns.map(raw => ({
        campaignId: raw.campaign_id,
        gachaId: raw.gacha_id,
        termIndex: raw.term_index,
        status: raw.status,
        periodStartTime: new Date(raw.period_start_time),
        periodEndTime: new Date(raw.period_end_time)
    }))
}

function insertPlayerStartDashExchangeCampaignSync(
    playerId: number,
    campaign: PlayerStartDashExchangeCampaign
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_start_dash_exchange_campaigns (campaign_id, gacha_id, term_index, status, period_start_time, period_end_time, player_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        campaign.campaignId, campaign.gachaId, campaign.termIndex,
        campaign.status,
        campaign.periodStartTime.toISOString(),
        campaign.periodEndTime.toISOString(),
        playerId
    )
}

export function insertPlayerStartDashExchangeCampaignsSync(
    playerId: number,
    campaigns: PlayerStartDashExchangeCampaign[]
) {
    const db = getDb();
    db.transaction(() => {
        for (const campaign of campaigns) {
            insertPlayerStartDashExchangeCampaignSync(playerId, campaign)
        }
    })()
}

// ─── Multi Special Exchange Campaign ───

/**
 * Gets the progress of a player's multi special exchange campaigns.
 * 
 * @param playerId The player's ID.
 * @returns The status of the player's multi special exchange campaigns.
 */
export function getPlayerMultiSpecialExchangeCampaignsSync(
    playerId: number
): PlayerMultiSpecialExchangeCampaign[] {
    const db = getDb();
    const rawCampaigns = db.prepare(`
    SELECT campaign_id, status
    FROM players_multi_special_exchange_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawPlayerMultiSpecialExchangeCampaign[]

    return rawCampaigns.map(raw => ({
        campaignId: raw.campaign_id,
        status: raw.status
    }))
}

function insertPlayerMultiSpecialExchangeCampaignSync(
    playerId: number,
    campaign: PlayerMultiSpecialExchangeCampaign
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_multi_special_exchange_campaigns (campaign_id, status, player_id)
    VALUES (?, ?, ?)
    `).run(campaign.campaignId, campaign.status, playerId)
}

export function insertPlayerMultiSpecialExchangeCampaignsSync(
    playerId: number,
    campaigns: PlayerMultiSpecialExchangeCampaign[]
) {
    const db = getDb();
    db.transaction(() => {
        for (const campaign of campaigns) {
            insertPlayerMultiSpecialExchangeCampaignSync(playerId, campaign)
        }
    })()
}

// ─── Special Exchange Campaign ───

/**
 * Gets the progress of a player's special exchange campaigns.
 *
 * @param playerId The player's ID.
 * @returns The status of the player's special exchange campaigns.
 */
export function getPlayerSpecialExchangeCampaignsSync(
    playerId: number
): PlayerSpecialExchangeCampaign[] {
    const db = getDb();
    const rawCampaigns = db.prepare(`
    SELECT campaign_id, status
    FROM players_special_exchange_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawPlayerSpecialExchangeCampaign[]

    return rawCampaigns.map(raw => ({
        campaignId: raw.campaign_id,
        status: raw.status
    }))
}

export function getPlayerSpecialExchangeCampaignStatusSync(
    playerId: number,
    campaignId: number
): number {
    const row = getDb().prepare(`
    SELECT status
    FROM players_special_exchange_campaigns
    WHERE player_id = ? AND campaign_id = ?
    `).get(playerId, campaignId) as { status: number } | undefined
    // Missing row means the campaign was never entered (status 0).
    return row?.status ?? 0
}

function insertPlayerSpecialExchangeCampaignSync(
    playerId: number,
    campaign: PlayerSpecialExchangeCampaign
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_special_exchange_campaigns (campaign_id, status, player_id)
    VALUES (?, ?, ?)
    `).run(campaign.campaignId, campaign.status, playerId)
}

export function insertPlayerSpecialExchangeCampaignsSync(
    playerId: number,
    campaigns: PlayerSpecialExchangeCampaign[]
) {
    const db = getDb();
    db.transaction(() => {
        for (const campaign of campaigns) {
            insertPlayerSpecialExchangeCampaignSync(playerId, campaign)
        }
    })()
}

export function upsertPlayerSpecialExchangeCampaignStatusSync(
    playerId: number,
    campaignId: number,
    status: number
): void {
    // 状态机 1→2→3 单调（双审 P2b 加固）：MAX 防御任何调用方的降级写入
    getDb().prepare(`
    INSERT INTO players_special_exchange_campaigns (campaign_id, status, player_id)
    VALUES (?, ?, ?)
    ON CONFLICT (campaign_id, player_id) DO UPDATE SET
        status = MAX(players_special_exchange_campaigns.status, excluded.status)
    `).run(campaignId, status, playerId)
}
