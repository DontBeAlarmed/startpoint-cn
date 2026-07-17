import { Database as BetterSqlite3Database } from "better-sqlite3"

export function ensureQuestHostFinishedStorageSync(db: BetterSqlite3Database) {
    const columns = db.pragma("table_info(players_quest_progress)") as { name: string }[]
    if (columns.some(column => column.name === "host_finished")) return

    db.prepare(`ALTER TABLE players_quest_progress ADD COLUMN host_finished INTEGER`).run()

    // Older builds exposed true to successful Advent clients without persisting it.
    db.prepare(`
        UPDATE players_quest_progress
        SET host_finished = 1
        WHERE host_finished IS NULL AND finished = 1 AND section IN (7, 8)
    `).run()
}
