import type { Database } from "better-sqlite3"

/**
 * social_follows 的 DDL 单一来源：主库（wdfpData 初始化器）与共享社交库
 * （MULTI_SOCIAL_DB_PATH，见 shared-db.ts）都从这里取表结构。
 *
 * 跨节点 follow 关系判定的共享副本（好友房间大厅可见性过滤的依据）：
 * 主键与查询全部走 viewer_id 域（全局身份）——本地 players_follows 的
 * player_id 是节点本地自增，不可跨节点。本地表仍是计费/lists 的权威，
 * 本表是双写副本；存量 players_follows 不迁移（player_id 域无反查映射）。
 */
export function ensureSocialFollowsSchema(database: Database): void {
    database.prepare(`CREATE TABLE IF NOT EXISTS social_follows (
        follower_viewer_id INTEGER NOT NULL,
        followed_viewer_id INTEGER NOT NULL,
        followed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (follower_viewer_id, followed_viewer_id),
        CHECK (follower_viewer_id <> followed_viewer_id)
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_social_follows_followed
        ON social_follows (followed_viewer_id)`).run()
}
