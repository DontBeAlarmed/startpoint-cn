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
        coop_bonus_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (follower_viewer_id, followed_viewer_id),
        CHECK (follower_viewer_id <> followed_viewer_id)
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_social_follows_followed
        ON social_follows (followed_viewer_id)`).run()
    ensureSocialFollowsCoopBonusColumn(database)
}

/**
 * 关注奖励（v4）计数列：方向行内嵌——"A 账号下与 B 的共斗奖励分"就存在
 * A→B 行上，取关删行即清零（无独立清理钩子），重关注新行从 0 起。
 * 存量库由 ALTER 补列（默认 0 = 无历史奖励）。
 */
export function ensureSocialFollowsCoopBonusColumn(database: Database): void {
    const columns = database.prepare(`PRAGMA table_info(social_follows)`).all() as { name: string }[]
    if (columns.some(column => column.name === "coop_bonus_count")) return
    try {
        database.prepare(`
            ALTER TABLE social_follows
            ADD COLUMN coop_bonus_count INTEGER NOT NULL DEFAULT 0
        `).run()
    } catch (error) {
        // 共享库双节点同时首开的竞态：败方等到的是"列已存在"——幂等通过
        if (!String(error).includes("duplicate column name")) throw error
    }
}
