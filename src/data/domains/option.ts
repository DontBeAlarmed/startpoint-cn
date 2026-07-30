import { getDb } from "../db";
import { RawPlayerOption } from "../types";
import { serializeBoolean, deserializeBoolean } from "../utils";

export interface PlayerProfileSettings {
    showOpenedManaBoardSecondCount: boolean
    showOwnedCharacterCount: boolean
    showOwnedDegreeCount: boolean
}

export type PlayerProfileSettingsUpdate = Partial<PlayerProfileSettings>

const PROFILE_SETTING_KEYS: Record<keyof PlayerProfileSettings, string> = {
    showOpenedManaBoardSecondCount: "profile.show_opened_mana_board_second_count",
    showOwnedCharacterCount: "profile.show_owned_character_count",
    showOwnedDegreeCount: "profile.show_owned_degree_count",
}

const DEFAULT_PROFILE_SETTINGS: PlayerProfileSettings = {
    showOpenedManaBoardSecondCount: false,
    showOwnedCharacterCount: true,
    showOwnedDegreeCount: true,
}

/**
 * Inserts a value for a player option.
 * 
 * @param playerId The ID of the player.
 * @param key The key of the option.
 * @param value The value of the option
 */
export function insertPlayerOptionSync(
    playerId: number,
    key: string,
    value: boolean
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_options (key, value, player_id)
    VALUES (?, ?, ?)
    `).run(key, serializeBoolean(value), playerId)
}

/**
 * Batch inserts a record of options into the database.
 * 
 * @param playerId The ID of the player that these options belong to.
 * @param options The record of options to insert.
 */
export function insertPlayerOptionsSync(
    playerId: number,
    options: Record<string, boolean>
) {
    const db = getDb();
    db.transaction(() => {
        for (const [key, value] of Object.entries(options)) {
            insertPlayerOptionSync(playerId, key, value)
        }
    })()
}

/**
 * Gets all of the options that a player has saved.
 * 
 * @param playerId The ID of the player.
 * @returns A record of options.
 */
export function getPlayerOptionsSync(
    playerId: number
): Record<string, boolean> {
    const db = getDb();
    const rawOptions = db.prepare(`
    SELECT key, value
    FROM players_options
    WHERE player_id = ? AND key NOT LIKE 'profile.%'
    `).all(playerId) as RawPlayerOption[]

    const result: Record<string, boolean> = {}
    for (const rawOption of rawOptions) {
        result[rawOption.key] = deserializeBoolean(rawOption.value)
    }

    return result
}

/**
 * Updates the value of a player option.
 * 
 * @param playerId The ID of the player to update the option of.
 * @param key The key of the option to update.
 * @param value The new value.
 */
export function updatePlayerOptionSync(
    playerId: number,
    key: string,
    value: boolean
) {
    const db = getDb();
    db.prepare(`
    UPDATE players_options
    SET value = ?
    WHERE key = ? AND player_id = ?    
    `).run(serializeBoolean(value), key, playerId)
}

/**
 * Batch updates a player's options.
 * 
 * @param playerId The ID of the player to update the options of.
 * @param options A record of options to update the values of.
 */
export function updatePlayerOptionsSync(
    playerId: number,
    options: Record<string, boolean>
) {
    // get all of a player's options
    const allOptions = getPlayerOptionsSync(playerId)

    const db = getDb();
    db.transaction(() => {
        for (const [key, newValue] of Object.entries(options)) {
            const existingValue = allOptions[key]
            if (existingValue === undefined) {
                insertPlayerOptionSync(playerId, key, newValue)
            } else if (newValue !== existingValue) {
                updatePlayerOptionSync(playerId, key, newValue)
            }
        }
    })()
}

export function getPlayerProfileSettingsSync(playerId: number): PlayerProfileSettings {
    const keys = Object.values(PROFILE_SETTING_KEYS)
    const rows = getDb().prepare(`
        SELECT key, value FROM players_options
        WHERE player_id = ? AND key IN (?, ?, ?)
    `).all(playerId, ...keys) as RawPlayerOption[]
    const stored = new Map(rows.map(row => [row.key, deserializeBoolean(row.value)]))
    return {
        showOpenedManaBoardSecondCount: stored.get(PROFILE_SETTING_KEYS.showOpenedManaBoardSecondCount)
            ?? DEFAULT_PROFILE_SETTINGS.showOpenedManaBoardSecondCount,
        showOwnedCharacterCount: stored.get(PROFILE_SETTING_KEYS.showOwnedCharacterCount)
            ?? DEFAULT_PROFILE_SETTINGS.showOwnedCharacterCount,
        showOwnedDegreeCount: stored.get(PROFILE_SETTING_KEYS.showOwnedDegreeCount)
            ?? DEFAULT_PROFILE_SETTINGS.showOwnedDegreeCount,
    }
}

export function updatePlayerProfileSettingsSync(
    playerId: number,
    settings: PlayerProfileSettingsUpdate,
): PlayerProfileSettings {
    getDb().transaction(() => {
        const upsert = getDb().prepare(`
            INSERT INTO players_options (key, value, player_id)
            VALUES (?, ?, ?)
            ON CONFLICT(key, player_id) DO UPDATE SET value = excluded.value
        `)
        for (const [property, value] of Object.entries(settings) as Array<
            [keyof PlayerProfileSettings, boolean]
        >) {
            upsert.run(PROFILE_SETTING_KEYS[property], serializeBoolean(value), playerId)
        }
    })()
    return getPlayerProfileSettingsSync(playerId)
}
