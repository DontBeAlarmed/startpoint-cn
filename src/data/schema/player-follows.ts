import { Database } from "better-sqlite3"

/**
 * 同服 Follow 有向边（F1）。关系只存在于同一 starpoint-cn 实例/同一 SQLite；
 * follower → followed 两行独立边即可派生 follow_state（互关/单向/被关注）与
 * follow_time/followed_time。玩家删除由外键级联清理；表排除在 player-save 外。
 */
export function initializePlayerFollowsSchemaSync(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS players_follows (
            follower_player_id INTEGER NOT NULL,
            followed_player_id INTEGER NOT NULL,
            followed_at INTEGER NOT NULL CHECK (followed_at >= 0),
            PRIMARY KEY (follower_player_id, followed_player_id),
            CHECK (follower_player_id <> followed_player_id),
            FOREIGN KEY (follower_player_id) REFERENCES players(id) ON DELETE CASCADE,
            FOREIGN KEY (followed_player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_players_follows_followed
        ON players_follows (followed_player_id, followed_at DESC, follower_player_id DESC);
    `)
}
