import { getDb } from "../db";
import { PlayerGachaInfo, PlayerGachaCampaign, RawPlayerGachaInfo, RawPlayerGachaCampaign } from "../types";
import { deserializeBoolean, serializeBoolean, deserializeNumberList } from "../utils/primitives";

/**
 * Converts a RawPlayerGachaInfo object into a PlayerGachaInfo object.
 * 
 * @param rawInfo The raw object to convert.
 * @returns The converted object.
 */
function buildPlayerGachaInfo(
    rawInfo: RawPlayerGachaInfo
): PlayerGachaInfo {
    return {
        gachaId: rawInfo.gacha_id,
        isDailyFirst: deserializeBoolean(rawInfo.is_daily_first),
        isAccountFirst: deserializeBoolean(rawInfo.is_account_first),
        gachaExchangePoint: rawInfo.gacha_exchange_point
    }
}

/**
 * Retrieves the status of various gacha banners for the player.
 * 
 * @param playerId The ID of the player.
 * @returns A list of PlayerGachaInfo.
 */
export function getPlayerGachaInfoListSync(
    playerId: number
): PlayerGachaInfo[] {
    const rawInfo = getDb().prepare(`
    SELECT gacha_id, is_daily_first, is_account_first, gacha_exchange_point
    FROM players_gacha_info
    WHERE player_id = ?
    `).all(playerId) as RawPlayerGachaInfo[]

    return rawInfo.map(raw => {
        return buildPlayerGachaInfo(raw)
    })
}

/**
 * Gets an individual gacha info for a player.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @returns The info that corresponds to the provided gachaId, or null.
 */
export function getPlayerGachaInfoSync(
    playerId: number,
    gachaId: number
): PlayerGachaInfo | null {
    const rawInfo = getDb().prepare(`
    SELECT gacha_id, is_daily_first, is_account_first, gacha_exchange_point
    FROM players_gacha_info
    WHERE player_id = ? AND gacha_id = ?
    `).get(playerId, gachaId) as RawPlayerGachaInfo

    return rawInfo === undefined ? null : buildPlayerGachaInfo(rawInfo)
}

/**
 * Inserts a singular gacha info into the database for a player.
 * 
 * @param playerId The ID of the player.
 * @param gachaInfo The PlayerGachaInfo data.
 */
export function insertPlayerGachaInfoSync(
    playerId: number,
    gachaInfo: PlayerGachaInfo
) {
    getDb().prepare(`
    INSERT INTO players_gacha_info (gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id)
    VALUES (?, ?, ?, ?, ?)
    `).run(
        gachaInfo.gachaId,
        serializeBoolean(gachaInfo.isDailyFirst),
        serializeBoolean(gachaInfo.isAccountFirst),
        gachaInfo.gachaExchangePoint == undefined ? null : gachaInfo.gachaExchangePoint,
        playerId
    )
}

/**
 * Batch inserts a list of gacha info into the database.
 * 
 * @param playerId The player's ID.
 * @param gachaInfoList The list of of PlayerGachaInfo data.
 */
export function insertPlayerGachaInfoListSync(
    playerId: number,
    gachaInfoList: PlayerGachaInfo[]
) {
    getDb().transaction(() => {
        for (const gachaInfo of gachaInfoList) {
            insertPlayerGachaInfoSync(playerId, gachaInfo)
        }
    })()
}

/**
 * Updates a player's gacha info.
 * 
 * @param playerId The ID of the player.
 * @param gachaInfo The partial PlayerGachaInfo object containing data to update.
 */
export function updatePlayerGachaInfoSync(
    playerId: number,
    gachaInfo: Partial<PlayerGachaInfo>
) {
    const id = gachaInfo.gachaId

    const fieldMap: Record<string, string> = {
        'isDailyFirst': 'is_daily_first',
        'isAccountFirst': 'is_account_first',
        'gachaExchangePoint': 'gacha_exchange_point'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in gachaInfo) {
        const value = gachaInfo[key as keyof PlayerGachaInfo]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (typeof (value) === "boolean") {
                values.push(serializeBoolean(value))
            } else {
                values.push(value)
            }
        }
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players_gacha_info
        SET ${sets.join(', ')}
        WHERE gacha_id = ? AND player_id = ?
        `).run([...values, id, playerId]);
}

/**
 * Converts a RawPlayerGachaCampaign into a PlayerGachaCampaign.
 * 
 * @param raw The RawPlayerGachaCampaign to convert.
 * @returns The converted PlayerGachaCampaign.
 */
function buildPlayerGachaCampaign(
    raw: RawPlayerGachaCampaign
): PlayerGachaCampaign {
    return {
        gachaId: raw.gacha_id,
        campaignId: raw.campaign_id,
        count: raw.count
    }
}

/**
 * Gets the status of an individual gacha campaign.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @param campaignId The ID of the gacha campaign.
 * @returns A PlayerGachaCampaign object or null.
 */
export function getPlayerGachaCampaignSync(
    playerId: number,
    gachaId: number,
    campaignId: number,
): PlayerGachaCampaign | null {
    const raw = getDb().prepare(`
    SELECT gacha_id, campaign_id, count
    FROM players_gacha_campaigns
    WHERE player_id = ? AND gacha_id = ? AND campaign_id = ?
    `).get(playerId, gachaId, campaignId) as RawPlayerGachaCampaign | undefined

    return raw === undefined ? null : buildPlayerGachaCampaign(raw)
}

/**
 * Batch gets a list of player gacha campaigns.
 * 
 * @param playerId The ID of the player.
 * @returns The list of gacha campaigns.
 */
export function getPlayerGachaCampaignListSync(
    playerId: number
): PlayerGachaCampaign[] {
    const rawList = getDb().prepare(`
    SELECT gacha_id, campaign_id, count
    FROM players_gacha_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawPlayerGachaCampaign[]

    return rawList.map(raw => buildPlayerGachaCampaign(raw))
}

/**
 * Inserts a gacha campaign into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param campaign The campaign to insert.
 */
export function insertPlayerGachaCampaignSync(
    playerId: number,
    campaign: PlayerGachaCampaign
) {
    getDb().prepare(`
    INSERT INTO players_gacha_campaigns (gacha_id, campaign_id, count, player_id)
    VALUES (?, ?, ?, ?)
    `).run(
        campaign.gachaId,
        campaign.campaignId,
        campaign.count,
        playerId
    )
}

export function insertPlayerGachaCampaignListSync(
    playerId: number,
    campaigns: PlayerGachaCampaign[]
) {
    getDb().transaction(() => {
        for (const campaign of campaigns) {
            insertPlayerGachaCampaignSync(playerId, campaign)
        }
    })()
}

/**
 * Updates a player's gacha campaign.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @param campaignId The ID of the gacha campaign.
 * @param newCount The new count the gacha campaign should have.
 */
export function updatePlayerGachaCampaignSync(
    playerId: number,
    gachaId: number,
    campaignId: number,
    newCount: number
) {
    getDb().prepare(`
    UPDATE players_gacha_campaigns
    SET count = ?
    WHERE player_id = ? AND gacha_id = ? AND campaign_id = ?
    `).run(
        newCount,
        playerId,
        gachaId,
        campaignId
    )
}
/**
/**
/**
/**
 * Retrieves the missions that a player is currently completing.
 * 
 * @param playerId The ID of the player.
 * @returns A record of each mission and its current progress.
 */
