import { getDb } from "../db";

export function getPlayerCharacterClearSync(playerId: number, characterId: number) {
    const row = getDb().prepare(`
    SELECT clear_count, multi_count FROM players_character_quest_clears
    WHERE player_id = ? AND character_id = ?
    `).get(playerId, characterId) as { clear_count: number; multi_count: number } | undefined;
    return row || { clear_count: 0, multi_count: 0 };
}

export function incrementPlayerCharacterClearSync(playerId: number, characterId: number, isMulti: boolean) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_character_quest_clears (player_id, character_id, clear_count, multi_count)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(player_id, character_id) DO UPDATE SET
        clear_count = clear_count + 1,
        multi_count = multi_count + ?
    `).run(playerId, characterId, isMulti ? 1 : 0, isMulti ? 1 : 0);
}
