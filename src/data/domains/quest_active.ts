import { getDb } from "../db";
import { PlayerActiveQuest, RawPlayerActiveQuest } from "../types";

function buildActiveQuest(raw: RawPlayerActiveQuest): PlayerActiveQuest {
    return {
        playerId: raw.player_id,
        playId: raw.play_id,
        questId: raw.quest_id,
        category: raw.category,
        useBossBoostPoint: raw.use_boss_boost_point === 1,
        useBoostPoint: raw.use_boost_point === 1,
        isAutoStartMode: raw.is_auto_start_mode === 1,
        isMulti: raw.is_multi === 1,
        roomNumber: raw.room_number,
        battleSessionId: raw.battle_session_id,
        entryItemId: raw.entry_item_id,
        entryItemCount: raw.entry_item_count,
        eventId: raw.event_id,
        continueCount: raw.continue_count
    }
}

export function getPlayerActiveQuestSync(playerId: number): PlayerActiveQuest | null {
    const raw = getDb().prepare(`
        SELECT * FROM players_active_quests WHERE player_id = ?
    `).get(playerId) as RawPlayerActiveQuest | undefined
    return raw ? buildActiveQuest(raw) : null
}

export function insertPlayerActiveQuestSync(playerId: number, quest: PlayerActiveQuest): void {
    getDb().prepare(`
        INSERT OR REPLACE INTO players_active_quests
            (player_id, play_id, quest_id, category, use_boss_boost_point,
             use_boost_point, is_auto_start_mode, is_multi, room_number,
             battle_session_id, entry_item_id, entry_item_count, event_id, continue_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        playerId, quest.playId, quest.questId, quest.category,
        quest.useBossBoostPoint ? 1 : 0, quest.useBoostPoint ? 1 : 0,
        quest.isAutoStartMode ? 1 : 0, quest.isMulti ? 1 : 0,
        quest.roomNumber ?? null, quest.battleSessionId ?? null, quest.entryItemId ?? null,
        quest.entryItemCount ?? null, quest.eventId ?? null, quest.continueCount
    )
}

export function deletePlayerActiveQuestSync(playerId: number): void {
    getDb().prepare(`DELETE FROM players_active_quests WHERE player_id = ?`).run(playerId)
}

export function updatePlayerActiveQuestContinueCountSync(playerId: number, continueCount: number): void {
    getDb().prepare(`
        UPDATE players_active_quests SET continue_count = ? WHERE player_id = ?
    `).run(continueCount, playerId)
}

export function updatePlayerActiveQuestEntryItemCountSync(playerId: number, itemCount: number): void {
    getDb().prepare(`
        UPDATE players_active_quests SET entry_item_count = ? WHERE player_id = ?
    `).run(itemCount, playerId)
}
