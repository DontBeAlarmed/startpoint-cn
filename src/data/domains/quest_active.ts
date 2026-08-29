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
        coordinatorOrigin: raw.coordinator_origin,
        roomNumber: raw.room_number,
        battleSessionId: raw.battle_session_id,
        entryItemId: raw.entry_item_id,
        entryItemCount: raw.entry_item_count,
        staminaCost: raw.stamina_cost,
        dailyChallengePointId: raw.daily_challenge_point_id,
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
    if (quest.isMulti && quest.coordinatorOrigin !== "remote" && quest.coordinatorOrigin !== "local") {
        throw new TypeError("Multi active quest coordinator origin must be remote or local")
    }
    const coordinatorOrigin = quest.isMulti ? quest.coordinatorOrigin : null
    getDb().prepare(`
        INSERT INTO players_active_quests
            (player_id, play_id, quest_id, category, use_boss_boost_point,
             use_boost_point, is_auto_start_mode, is_multi, room_number,
             battle_session_id, coordinator_origin, entry_item_id, entry_item_count,
             stamina_cost, daily_challenge_point_id, event_id, continue_count)
        VALUES (
            @player_id, @play_id, @quest_id, @category, @use_boss_boost_point,
            @use_boost_point, @is_auto_start_mode, @is_multi, @room_number,
            @battle_session_id, @coordinator_origin, @entry_item_id,
            @entry_item_count, @stamina_cost, @daily_challenge_point_id,
            @event_id, @continue_count
        )
    `).run({
        player_id: playerId,
        play_id: quest.playId,
        quest_id: quest.questId,
        category: quest.category,
        use_boss_boost_point: quest.useBossBoostPoint ? 1 : 0,
        use_boost_point: quest.useBoostPoint ? 1 : 0,
        is_auto_start_mode: quest.isAutoStartMode ? 1 : 0,
        is_multi: quest.isMulti ? 1 : 0,
        room_number: quest.roomNumber ?? null,
        battle_session_id: quest.battleSessionId ?? null,
        coordinator_origin: coordinatorOrigin,
        entry_item_id: quest.entryItemId ?? null,
        entry_item_count: quest.entryItemCount ?? null,
        stamina_cost: quest.staminaCost ?? null,
        daily_challenge_point_id: quest.dailyChallengePointId ?? null,
        event_id: quest.eventId ?? null,
        continue_count: quest.continueCount,
    })
}

export function updatePlayerActiveQuestCoordinatorOriginSync(
    playerId: number,
    coordinatorOrigin: "remote" | "local",
): void {
    getDb().prepare(`
        UPDATE players_active_quests
        SET coordinator_origin = ?
        WHERE player_id = ? AND is_multi = 1 AND coordinator_origin IS NULL
    `).run(coordinatorOrigin, playerId)
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
