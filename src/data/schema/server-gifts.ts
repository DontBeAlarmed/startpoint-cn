import { Database } from "better-sqlite3"

export function initializeServerGiftsSchemaSync(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS server_gift_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT COLLATE BINARY NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'stopped'
                CHECK (status IN ('stopped', 'active')),
            note TEXT,
            reward_revision INTEGER NOT NULL DEFAULT 1 CHECK (reward_revision > 0),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_gift_rewards (
            gift_id INTEGER NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 0),
            type INTEGER NOT NULL CHECK (type IN (1, 4, 5, 6, 8, 9)),
            type_id INTEGER,
            number INTEGER NOT NULL CHECK (number > 0),
            PRIMARY KEY (gift_id, position),
            FOREIGN KEY (gift_id) REFERENCES server_gift_codes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS players_gift_redemptions (
            gift_id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            reward_revision INTEGER NOT NULL CHECK (reward_revision > 0),
            reward_snapshot TEXT NOT NULL,
            redeemed_at TEXT NOT NULL,
            inherited_from_player_id INTEGER,
            PRIMARY KEY (gift_id, player_id),
            FOREIGN KEY (gift_id) REFERENCES server_gift_codes(id) ON DELETE CASCADE,
            FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
            FOREIGN KEY (inherited_from_player_id) REFERENCES players(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_server_gift_codes_status
        ON server_gift_codes (status, id DESC);

        CREATE INDEX IF NOT EXISTS idx_players_gift_redemptions_gift_time
        ON players_gift_redemptions (gift_id, redeemed_at DESC, player_id DESC);
    `)
}
