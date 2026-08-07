import { getDb } from "../db";
import { PlayerBoxGacha, PlayerBoxGachaDrawnReward, RawPlayerBoxGacha } from "../types";
import { deserializeBoolean, serializeBoolean, deserializeNumberList } from "../utils/primitives";

/**
 * Converts a RawPlayerBoxGacha object into a PlayerBoxGacha object.
 * 
 * @param raw The raw object to convert.
 * @returns The converted object.
 */
function buildPlayerBoxGacha(
    raw: RawPlayerBoxGacha
): PlayerBoxGacha {
    return {
        boxId: raw.box_id,
        resetTimes: raw.reset_times,
        remainingNumber: raw.remaining_number,
        isClosed: deserializeBoolean(raw.is_closed)
    }
}

/**
 * Gets the data for an individual player box gacha.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the box gacha.
 * @param boxId The ID of the box.
 * @returns A PlayerBoxGacha object or null.
 */
export function getPlayerBoxGachaSync(
    playerId: number,
    gachaId: number,
    boxId: number
): PlayerBoxGacha | null {
    const rawBox = getDb().prepare(`
    SELECT id, box_id, reset_times, remaining_number, is_closed
    FROM players_box_gacha
    WHERE player_id = ? AND id = ? AND box_id = ?
    `).get(playerId, gachaId, boxId) as RawPlayerBoxGacha

    if (rawBox === undefined) return null;

    return buildPlayerBoxGacha(rawBox)
}

/**
 * Gets a player's box gachas.
 * 
 * @param playerId The ID of the player
 * @returns A record containing the status of the player's box gachas.
 */
export function getPlayerBoxGachasSync(
    playerId: number
): Record<string, PlayerBoxGacha[]> {

    const rawBoxes = getDb().prepare(`
    SELECT id, box_id, reset_times, remaining_number, is_closed
    FROM players_box_gacha
    WHERE player_id = ?
    `).all(playerId) as RawPlayerBoxGacha[]

    const buckets: Record<string, PlayerBoxGacha[]> = {}

    for (const rawBox of rawBoxes) {
        const id = rawBox.id.toString()
        let bucket = buckets[id]
        if (!bucket) {
            bucket = []
            buckets[id] = bucket
        }
        bucket.push(buildPlayerBoxGacha(rawBox))
    }

    return buckets
}

/**
 * Inserts a singular box gacha into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param gachaId 
 * @param boxGacha The box gacha's data.
 */
export function insertPlayerBoxGachaSync(
    playerId: number,
    gachaId: number | string,
    boxGacha: PlayerBoxGacha
) {
    getDb().prepare(`
    INSERT INTO players_box_gacha (id, box_id, reset_times, remaining_number, is_closed, player_id)
    VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        Number(gachaId),
        boxGacha.boxId,
        boxGacha.resetTimes,
        boxGacha.remainingNumber,
        serializeBoolean(boxGacha.isClosed),
        playerId
    )
}

/**
 * Batch inserts a record of box gachas into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param boxGachas The record of box gachas.
 */
export function insertPlayerBoxGachasSync(
    playerId: number,
    boxGachas: Record<string, PlayerBoxGacha[]>
) {
    getDb().transaction(() => {
        for (const [section, list] of Object.entries(boxGachas)) {
            for (const boxGacha of list) {
                insertPlayerBoxGachaSync(playerId, section, boxGacha)
            }
        }
    })()
}

/**
 * Updates a player's box gacha box.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the box gacha that this box belongs to.
 * @param boxGacha 
 * 
 */
export function updatePlayerBoxGachaSync(
    playerId: number,
    gachaId: number | string,
    boxGacha: Partial<PlayerBoxGacha> & Pick<PlayerBoxGacha, 'boxId'>
) {
    const fieldMap: Record<string, string> = {
        'resetTimes': 'reset_times',
        'remainingNumber': 'remaining_number',
        'isClosed': 'is_closed'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in boxGacha) {
        const value = boxGacha[key as keyof PlayerBoxGacha]
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
        UPDATE players_box_gacha
        SET ${sets.join(', ')}
        WHERE player_id = ? AND id = ? AND box_id = ?
        `).run([
        ...values,
        playerId,
        Number(gachaId),
        boxGacha.boxId
    ]);
}

/**
 * Gets all of the drawn rewards for a specific box gacha & box for a player.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The id of the box gacha.
 * @param boxId The box's ID.
 * @returns A list of drawn rewards.
 */
export function getPlayerBoxGachaDrawnRewardsSync(
    playerId: number,
    gachaId: number,
    boxId: string | number
): PlayerBoxGachaDrawnReward[] {
    return getDb().prepare(`
    SELECT id, number
    FROM players_box_gacha_drawn_rewards
    WHERE box_id = ? AND gacha_id = ? AND player_id = ?
    `).all(Number(boxId), gachaId, playerId) as PlayerBoxGachaDrawnReward[]
}

/** Deletes drawn rewards for exactly one player's box. */
export function deletePlayerBoxGachaDrawnRewardsSync(
    playerId: number,
    gachaId: number,
    boxId: string | number
) {
    getDb().prepare(`
    DELETE FROM players_box_gacha_drawn_rewards
    WHERE player_id = ? AND gacha_id = ? AND box_id = ?
    `).run(playerId, gachaId, Number(boxId))
}

/**
 * Inserts a drawn reward for a box gacha.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The id of the box gacha.
 * @param boxId The box's ID.
 * @param reward The reward to insert.
 */
export function insertPlayerBoxGachaDrawnRewardSync(
    playerId: number,
    gachaId: number,
    boxId: string | number,
    reward: PlayerBoxGachaDrawnReward
) {
    getDb().prepare(`
    INSERT INTO players_box_gacha_drawn_rewards (id, box_id, gacha_id, number, player_id)
    VALUES (?, ?, ?, ?, ?)
    `).run(
        reward.id,
        Number(boxId),
        gachaId,
        reward.number,
        playerId
    )
}

/**
 * Updates a drawn reward for a box gacha.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The id of the box gacha.
 * @param boxId The box's ID.
 * @param rewardId A list of drawn rewards.
 * @param newNumber The new number value the drawn reward should have.
 */
export function updatePlayerBoxGachaDrawnRewardSync(
    playerId: number,
    gachaId: number,
    boxId: string | number,
    rewardId: string | number,
    newNumber: number
) {
    getDb().prepare(`
    UPDATE players_box_gacha_drawn_rewards
    SET number = ?
    WHERE player_id = ? AND gacha_id = ? AND box_id = ? AND id = ?
    `).run(
        newNumber,
        playerId,
        gachaId,
        Number(boxId),
        Number(rewardId),
    )
}

/**
/**
/**
/**
/**
/**
/**
 * Deserializes a RawPlayerRushEvent into a PlayerRushEvent
 * 
 * @param raw 
 * @param endlessBattleNextRound The next endless battle round for this event.
 */
