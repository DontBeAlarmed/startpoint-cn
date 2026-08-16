// Tracks per-character powerflip count for leader-specific powerflip missions (1210012)
// Accumulates zone powerflips to the leader character's counter

import { getDb } from "../../../data/db"
import type { FinishContext } from "./types"
import {
    MAX_SAFE_BATTLE_COUNTER,
    saturatingAddNonNegativeSafeIntegers,
} from "./powerflip-tracker"

export function trackLeaderPowerflip(ctx: FinishContext): void {
    const zones = ctx.statistics.zones || []
    let powerFlipCount = 0
    for (const zone of zones) {
        powerFlipCount = saturatingAddNonNegativeSafeIntegers(
            powerFlipCount,
            zone.use_power_flip_count ?? 0,
        )
    }
    if (powerFlipCount === 0) return

    const leaderId = ctx.party.characters[0]?.id
    if (!leaderId) return

    const db = getDb()
    db.prepare(`
    INSERT INTO players_character_quest_clears (player_id, character_id, clear_count, multi_count, leader_clear_count, leader_multi_count, leader_power_flip_count)
    VALUES (?, ?, 0, 0, 0, 0, ?)
    ON CONFLICT(player_id, character_id) DO UPDATE SET
        leader_power_flip_count = CASE
            WHEN leader_power_flip_count < 0 THEN excluded.leader_power_flip_count
            WHEN leader_power_flip_count >= ? - excluded.leader_power_flip_count THEN ?
            ELSE leader_power_flip_count + excluded.leader_power_flip_count
        END
    `).run(ctx.playerId, leaderId, powerFlipCount,
        MAX_SAFE_BATTLE_COUNTER, MAX_SAFE_BATTLE_COUNTER)
}
