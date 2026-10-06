import type { Database } from "better-sqlite3"

/**
 * 社交域（铃铛招募 + 共享 presence）的 DDL 单一来源：
 * 主库（wdfpData 初始化器）与共享社交库（MULTI_SOCIAL_DB_PATH 指向的共享文件，
 * 见 shared-db.ts）都从这里取表结构，保证两处 schema 永远一致。
 * 全部语句幂等（IF NOT EXISTS），多进程同时初始化安全（配合 busy_timeout）。
 */
export function ensureAttentionSchema(database: Database): void {
    // 铃铛招募（新手房主开随机招募 → 投递给在线可加入玩家）
    database.prepare(`CREATE TABLE IF NOT EXISTS attention_recruitments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attention_key TEXT NOT NULL UNIQUE,
        room_number TEXT NOT NULL,
        host_pid INTEGER NOT NULL,
        host_viewer_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        is_newbie_host INTEGER NOT NULL DEFAULT 0,
        establisher_json TEXT NOT NULL DEFAULT '{}',
        posted_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
    )`).run()
    database.prepare(`CREATE TABLE IF NOT EXISTS attention_deliveries (
        recruitment_id INTEGER NOT NULL,
        viewer_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'delivered',
        acted_at_ms INTEGER,
        PRIMARY KEY (recruitment_id, viewer_id)
    )`).run()
    // 投递热路径（每在线玩家每 ~10s 一次 /attention/check）与 share_room 的
    // get-or-create 都靠这两个索引；行清理见 attention 域 pruneExpiredRecruitments
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_attention_recruitments_host_room
        ON attention_recruitments (host_viewer_id, room_number)`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_attention_recruitments_status_expires
        ON attention_recruitments (status, expires_at_ms)`).run()
}

/** 共享 presence 表（仅共享社交库使用；默认部署 presence 为节点内内存 Map） */
export function ensurePresenceSchema(database: Database): void {
    database.prepare(`CREATE TABLE IF NOT EXISTS social_presence (
        viewer_id INTEGER PRIMARY KEY,
        last_seen_ms INTEGER NOT NULL
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_social_presence_last_seen
        ON social_presence (last_seen_ms)`).run()
}
