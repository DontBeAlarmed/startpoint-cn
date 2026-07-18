import type { Database } from "better-sqlite3"

export function ensureActiveQuestEntryItemCountStorageSync(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(players_active_quests)`).all() as { name: string }[]
    if (columns.some(column => column.name === "entry_item_count")) return
    database.prepare(`
        ALTER TABLE players_active_quests
        ADD COLUMN entry_item_count INTEGER
    `).run()
}
