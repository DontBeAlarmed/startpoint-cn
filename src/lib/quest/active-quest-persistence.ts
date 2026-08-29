import type { Database } from "better-sqlite3"

export function ensureActiveQuestEntryItemCountStorageSync(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(players_active_quests)`).all() as { name: string }[]
    if (columns.some(column => column.name === "entry_item_count")) return
    database.prepare(`
        ALTER TABLE players_active_quests
        ADD COLUMN entry_item_count INTEGER
    `).run()
}

export function ensureActiveQuestBattleSessionIdStorageSync(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(players_active_quests)`).all() as { name: string }[]
    if (columns.some(column => column.name === "battle_session_id")) return
    database.prepare(`
        ALTER TABLE players_active_quests
        ADD COLUMN battle_session_id TEXT
    `).run()
}

export function ensureActiveQuestResourceCostStorageSync(database: Database): void {
    const readColumns = () => database
        .prepare(`PRAGMA table_info(players_active_quests)`)
        .all() as { name: string }[]
    if (!readColumns().some(column => column.name === "stamina_cost")) {
        database.prepare(`
            ALTER TABLE players_active_quests
            ADD COLUMN stamina_cost INTEGER
        `).run()
    }
    if (!readColumns().some(column => column.name === "daily_challenge_point_id")) {
        database.prepare(`
            ALTER TABLE players_active_quests
            ADD COLUMN daily_challenge_point_id INTEGER
        `).run()
    }
}

export function ensureActiveQuestCoordinatorOriginStorageSync(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(players_active_quests)`).all() as { name: string }[]
    if (columns.some(column => column.name === "coordinator_origin")) return
    database.prepare(`
        ALTER TABLE players_active_quests
        ADD COLUMN coordinator_origin TEXT
        CHECK (coordinator_origin IS NULL OR coordinator_origin IN ('remote', 'local'))
    `).run()
}

export function ensureActiveQuestRescueFragmentEligibilityStorageSync(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(players_active_quests)`).all() as { name: string }[]
    if (columns.some(column => column.name === "rescue_fragment_eligible")) return
    database.prepare(`
        ALTER TABLE players_active_quests
        ADD COLUMN rescue_fragment_eligible INTEGER NOT NULL DEFAULT 0
        CHECK (rescue_fragment_eligible IN (0, 1))
    `).run()
}
