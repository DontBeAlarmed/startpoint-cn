import { Database } from "better-sqlite3"

export function initializeServerNewsSchemaSync(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS server_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category INTEGER NOT NULL CHECK (category IN (1, 2, 3)),
            title TEXT NOT NULL,
            published_at_real TEXT NOT NULL,
            body_rich_text TEXT NOT NULL,
            label INTEGER NOT NULL CHECK (label BETWEEN 1 AND 8),
            thumbnail INTEGER NOT NULL CHECK (thumbnail BETWEEN 1 AND 13),
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `)
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_server_news_visibility
        ON server_news (enabled, category, published_at_real DESC, id DESC)
    `)
}

export function migrateServerNewsSchema23Sync(
    database: Database,
    currentVersion: number,
): void {
    if (currentVersion > 22) return
    database.prepare(
        "DELETE FROM players_options WHERE key GLOB 'server.forced_news.*'",
    ).run()
}
