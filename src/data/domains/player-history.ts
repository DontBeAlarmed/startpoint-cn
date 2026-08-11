import { getDb } from "../db"

export interface PlayerHistoryFavoriteCharacters {
    characterIds: Array<number | null>
    unisonCharacterIds: Array<number | null>
}

export interface PlayerHistorySettings extends PlayerHistoryFavoriteCharacters {
    playerHistoryId: number
    backgroundCardId: number
    degreeId: number
    topicVisibility: Record<string, boolean>
}

export type PlayerHistorySettingsUpdate = Partial<Pick<
    PlayerHistorySettings,
    "backgroundCardId" | "degreeId" | "characterIds" | "unisonCharacterIds" | "topicVisibility"
>>

interface RawPlayerHistorySettings {
    player_history_id: number
    background_card_id: number
    degree_id: number
    character_ids: string
    unison_character_ids: string
    topic_visibility: string
}

function parseCharacterIds(value: string, fallback: Array<number | null>): Array<number | null> {
    try {
        const parsed = JSON.parse(value)
        if (
            Array.isArray(parsed)
            && parsed.length === 3
            && parsed.every(id => id === null || (Number.isSafeInteger(id) && id > 0))
        ) return parsed
    } catch {
        // Damaged optional presentation settings fall back to the current party.
    }
    return [...fallback]
}

function parseTopicVisibility(value: string): Record<string, boolean> {
    try {
        const parsed = JSON.parse(value)
        if (
            parsed !== null
            && typeof parsed === "object"
            && !Array.isArray(parsed)
            && Object.entries(parsed).every(([key, visible]) => /^\d+$/.test(key) && typeof visible === "boolean")
        ) return parsed as Record<string, boolean>
    } catch {
        // Damaged optional presentation settings are equivalent to no visible topics.
    }
    return {}
}

export function getPlayerHistorySettingsSync(
    playerId: number,
    defaults: PlayerHistorySettings,
): PlayerHistorySettings {
    const row = getDb().prepare(`
        SELECT player_history_id, background_card_id, degree_id,
               character_ids, unison_character_ids, topic_visibility
        FROM players_player_history_settings
        WHERE player_id = ?
    `).get(playerId) as RawPlayerHistorySettings | undefined
    if (!row) return {
        ...defaults,
        characterIds: [...defaults.characterIds],
        unisonCharacterIds: [...defaults.unisonCharacterIds],
        topicVisibility: { ...defaults.topicVisibility },
    }
    return {
        playerHistoryId: row.player_history_id,
        backgroundCardId: row.background_card_id,
        degreeId: row.degree_id,
        characterIds: parseCharacterIds(row.character_ids, defaults.characterIds),
        unisonCharacterIds: parseCharacterIds(row.unison_character_ids, defaults.unisonCharacterIds),
        topicVisibility: parseTopicVisibility(row.topic_visibility),
    }
}

export function updatePlayerHistorySettingsSync(
    playerId: number,
    defaults: PlayerHistorySettings,
    update: PlayerHistorySettingsUpdate,
): PlayerHistorySettings {
    const current = getPlayerHistorySettingsSync(playerId, defaults)
    const next = {
        ...current,
        ...update,
        topicVisibility: update.topicVisibility === undefined
            ? current.topicVisibility
            : { ...current.topicVisibility, ...update.topicVisibility },
    }
    getDb().prepare(`
        INSERT INTO players_player_history_settings (
            player_id, player_history_id, background_card_id, degree_id,
            character_ids, unison_character_ids, topic_visibility
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            player_history_id = excluded.player_history_id,
            background_card_id = excluded.background_card_id,
            degree_id = excluded.degree_id,
            character_ids = excluded.character_ids,
            unison_character_ids = excluded.unison_character_ids,
            topic_visibility = excluded.topic_visibility
    `).run(
        playerId,
        next.playerHistoryId,
        next.backgroundCardId,
        next.degreeId,
        JSON.stringify(next.characterIds),
        JSON.stringify(next.unisonCharacterIds),
        JSON.stringify(next.topicVisibility),
    )
    return next
}
