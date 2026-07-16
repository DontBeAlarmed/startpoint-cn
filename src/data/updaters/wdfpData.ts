// Updates an outdated wdfp_data database

import { Database } from "better-sqlite3";
import awakeRewards from "../../../assets/mission_char_awake_reward.json";

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
}
