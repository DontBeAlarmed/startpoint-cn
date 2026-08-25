// Updates an outdated wdfp_data database

import { Database } from "better-sqlite3";
import awakeRewards from "../../../assets/mission_char_awake_reward.json";

function parseDecimalSafeInteger(value: unknown): number | null {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null

    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Updates a database before its initialization function has been called.
 * 
 * @param database A better-sqlite3 database.
 */
export function updateBeforeInit(
    database: Database,
    currentVersion: number
) {
    if (0 >= currentVersion) {
        // update to version 1
        // Only run if tables exist and _old tables don't (skip for fresh DBs or already-migrated DBs)
        const tableExists = database.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='players_parties'"
        ).get();
        const oldExists = database.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='players_parties_old'"
        ).get();
        if (tableExists && !oldExists) {
            database.prepare(`ALTER TABLE players_parties RENAME TO players_parties_old`).run()
            database.prepare(`ALTER TABLE players_party_groups RENAME TO players_party_groups_old`).run()
        }
    }

    if (1 >= currentVersion) {
        // update to version 2
        const tableExists = database.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='players_party_options'"
        ).get();
        if (tableExists) {
            database.prepare(`DROP TABLE players_party_options`).run()
        }
    }

    if (18 >= currentVersion) {
        const tableExists = database.prepare(`
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'players_login_bonus_progress'
        `).get()
        const oldExists = database.prepare(`
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'players_login_bonus_progress_old'
        `).get()
        if (tableExists && !oldExists) {
            database.prepare(`
                ALTER TABLE players_login_bonus_progress
                RENAME TO players_login_bonus_progress_old
            `).run()
        }
    }
}

/**
 * Updates a database after its initialization function has been called.
 * 
 * @param database A better-sqlite3 database.
 */
export function updateAfterInit(
    database: Database,
    currentVersion: number
) {
    if (0 >= currentVersion) {
        // update to version 1
        // Only run if _old tables exist (skip for fresh DBs)
        const oldTableExists = database.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='players_party_groups_old'"
        ).get();
        if (oldTableExists) {
            database.prepare(`
            INSERT INTO players_party_groups
            SELECT *, 1 FROM players_party_groups_old
            `).run()

            database.prepare(`
            INSERT INTO players_parties
            SELECT *, 1 FROM players_parties_old
            `).run()
            database.prepare(`DELETE FROM players_parties_old`).run()
            database.prepare(`DELETE FROM players_party_groups_old`).run()
        }
    }

    if (2 >= currentVersion) {
        const awakeMissionIds = Object.keys(awakeRewards as Record<string, unknown>).map(Number)
        if (awakeMissionIds.length > 0) {
            const placeholders = awakeMissionIds.map(() => "?").join(",")
            database.transaction(() => {
                database.prepare(`
                INSERT OR IGNORE INTO players_category_missions (category, id, progress, player_id)
                SELECT 9, id, progress, player_id
                FROM players_active_missions
                WHERE id IN (${placeholders})
                `).run(...awakeMissionIds)
                database.prepare(`
                INSERT OR IGNORE INTO players_category_mission_stages
                    (category, id, status, player_id, mission_id)
                SELECT 9, id, status, player_id, mission_id
                FROM players_active_missions_stages
                WHERE mission_id IN (${placeholders})
                `).run(...awakeMissionIds)
                database.prepare(`
                DELETE FROM players_active_missions_stages
                WHERE mission_id IN (${placeholders})
                `).run(...awakeMissionIds)
                database.prepare(`
                DELETE FROM players_active_missions
                WHERE id IN (${placeholders})
                `).run(...awakeMissionIds)
            })()
        }
    }

    if (3 >= currentVersion) {
        const insertUnlock = database.prepare(`
            INSERT INTO players_character_awake_unlocks
                (player_id, character_id, board_index, awake_level)
            SELECT mission_stage.player_id, owned_character.id, ?, ?
            FROM players_category_mission_stages AS mission_stage
            JOIN players_characters AS owned_character
              ON owned_character.player_id = mission_stage.player_id
             AND owned_character.id = ?
            WHERE mission_stage.category = 9
              AND mission_stage.mission_id = ?
              AND mission_stage.id = ?
              AND mission_stage.status = 1
            ON CONFLICT(player_id, character_id, board_index) DO UPDATE SET
                awake_level = MAX(awake_level, excluded.awake_level)
        `)

        const missionRewards = awakeRewards as Record<string, Record<string, unknown>>
        database.transaction(() => {
            for (const [rawMissionId, stages] of Object.entries(missionRewards)) {
                const missionId = parseDecimalSafeInteger(rawMissionId)
                if (missionId === null || missionId <= 0) continue

                for (const [rawStageId, wrappedRows] of Object.entries(stages)) {
                    const stageId = parseDecimalSafeInteger(rawStageId)
                    if (stageId === null || stageId <= 0 || !Array.isArray(wrappedRows)) continue

                    const row = wrappedRows[0]
                    if (!Array.isArray(row)) continue

                    const specialKind = parseDecimalSafeInteger(row[1])
                    const characterId = parseDecimalSafeInteger(row[2])
                    const boardIndex = parseDecimalSafeInteger(row[3])
                    const awakeLevel = parseDecimalSafeInteger(row[4])
                    if (
                        specialKind !== 0
                        || characterId === null || characterId <= 0
                        || boardIndex === null || boardIndex <= 0
                        || awakeLevel === null || awakeLevel <= 0
                    ) continue

                    insertUnlock.run(
                        boardIndex,
                        awakeLevel,
                        characterId,
                        missionId,
                        stageId
                    )
                }
            }
        })()
    }

    if (4 >= currentVersion) {
        const hasPeriodicSnapshots = database.prepare(`
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'players_periodic_snapshots'
        `).get()
        if (!hasPeriodicSnapshots) return

        database.prepare(`
            INSERT OR IGNORE INTO players_periodic_snapshots (
                player_id, period_type, quest_clears, stamina_used,
                rank_ss, rank_s, rank_a, rank_b,
                single_play_count, single_clear_count,
                multi_play_count, multi_clear_count,
                multi_host_clear_count, multi_guest_clear_count,
                dash_count, power_flip_count, login_days, updated_at
            )
            SELECT player.id, period.period_type,
                   0, player.total_stamina_used,
                   COALESCE(counter.rank_ss_count, 0), COALESCE(counter.rank_s_count, 0),
                   COALESCE(counter.rank_a_count, 0), COALESCE(counter.rank_b_count, 0),
                   COALESCE(counter.single_play_count, 0), COALESCE(counter.single_clear_count, 0),
                   COALESCE(counter.multi_play_count, 0), COALESCE(counter.multi_clear_count, 0),
                   COALESCE(counter.multi_host_clear_count, 0), COALESCE(counter.multi_guest_clear_count, 0),
                   player.total_dashes, player.total_powerflips, player.total_login_days,
                   datetime('now')
            FROM players AS player
            CROSS JOIN (
                SELECT 'daily' AS period_type
                UNION ALL SELECT 'weekly'
            ) AS period
            LEFT JOIN players_mission_battle_counters AS counter
              ON counter.player_id = player.id
        `).run()
        database.prepare(`
            UPDATE players_periodic_snapshots
            SET single_play_count = COALESCE((
                    SELECT single_play_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                single_clear_count = COALESCE((
                    SELECT single_clear_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                multi_play_count = COALESCE((
                    SELECT multi_play_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                multi_clear_count = COALESCE((
                    SELECT multi_clear_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                multi_host_clear_count = COALESCE((
                    SELECT multi_host_clear_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                multi_guest_clear_count = COALESCE((
                    SELECT multi_guest_clear_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                dash_count = COALESCE((
                    SELECT total_dashes FROM players
                    WHERE id = players_periodic_snapshots.player_id
                ), 0),
                power_flip_count = COALESCE((
                    SELECT total_powerflips FROM players
                    WHERE id = players_periodic_snapshots.player_id
                ), 0),
                login_days = COALESCE((
                    SELECT total_login_days FROM players
                    WHERE id = players_periodic_snapshots.player_id
                ), 0),
                rank_ss = COALESCE((
                    SELECT rank_ss_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                rank_s = COALESCE((
                    SELECT rank_s_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                rank_a = COALESCE((
                    SELECT rank_a_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0),
                rank_b = COALESCE((
                    SELECT rank_b_count FROM players_mission_battle_counters
                    WHERE player_id = players_periodic_snapshots.player_id
                ), 0)
        `).run()
    }

    if (18 >= currentVersion) {
        const oldTableExists = database.prepare(`
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'players_login_bonus_progress_old'
        `).get()
        if (oldTableExists) {
            database.prepare(`
                INSERT INTO players_login_bonus_progress (
                    player_id, group_id, last_granted_index,
                    last_granted_business_day, received_at, shown_at
                )
                SELECT player_id, group_id, last_granted_index,
                       last_granted_business_day, received_at, shown_at
                FROM players_login_bonus_progress_old
            `).run()
            database.prepare("DROP TABLE players_login_bonus_progress_old").run()
        }
    }
}
