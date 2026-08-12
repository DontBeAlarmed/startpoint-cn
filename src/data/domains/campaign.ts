import { getDb } from "../db";
import {
    PlayerPeriodicRewardPoint,
    PlayerStartDashExchangeCampaign,
    PlayerMultiSpecialExchangeCampaign,
    RawPlayerStartDashExchangeCampaign,
    RawPlayerMultiSpecialExchangeCampaign,
} from "../types";
import bundledHardMultiEvents from "../../../assets/hard_multi_event.json";
import bundledHardMultiQuests from "../../../assets/hard_multi_event_quest.json";
import bundledPeriodicRewardPoints from "../../../assets/periodic_reward_point.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";

// ─── Periodic Reward Points ───

interface HardMultiEventDefinition {
    periodicPointId?: number
}

interface HardMultiQuestDefinition {
    periodicRewardGroupId?: number
}

interface PeriodicRewardPointDefinition {
    maxPoint: number
    recoveryPoint: number
    recoveryCycle: number
}

const FINAL_OPERATION_EVENT_IDS = new Set([1001, 1002, 1003, 1004, 1005, 1006])

function getActivityPeriodicRewardDefinitions(): ReadonlyMap<
    number,
    PeriodicRewardPointDefinition
> {
    const events = getRuntimeContentTableSync(
        "hard_multi_event.json",
        bundledHardMultiEvents as Record<string, HardMultiEventDefinition>,
    )
    const points = getRuntimeContentTableSync(
        "periodic_reward_point.json",
        bundledPeriodicRewardPoints as Record<string, PeriodicRewardPointDefinition>,
    )
    const quests = getRuntimeContentTableSync(
        "hard_multi_event_quest.json",
        bundledHardMultiQuests as Record<string, HardMultiQuestDefinition>,
    )
    const definitions = new Map<number, PeriodicRewardPointDefinition>()
    for (const event of Object.values(events)) {
        if (event.periodicPointId === undefined) continue
        const definition = points[String(event.periodicPointId)]
        if (definition !== undefined) definitions.set(event.periodicPointId, definition)
    }
    for (const [questId, quest] of Object.entries(quests)) {
        if (!FINAL_OPERATION_EVENT_IDS.has(Math.floor(Number(questId) / 1000))) continue
        const pointId = quest.periodicRewardGroupId
        if (pointId === undefined || definitions.has(pointId)) continue
        const definition = points[String(pointId)]
        if (definition !== undefined) definitions.set(pointId, definition)
    }
    return definitions
}

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
    for (const [id, definition] of getActivityPeriodicRewardDefinitions()) {
        if (existingIds.has(id)) continue
        insert.run(id, definition.recoveryPoint, playerId)
    }
}

export function recoverActivityPeriodicRewardPointsSync(playerId: number): void {
    const definitions = getActivityPeriodicRewardDefinitions()
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
