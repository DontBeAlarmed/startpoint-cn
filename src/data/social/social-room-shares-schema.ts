import type { Database } from "better-sqlite3"

/**
 * social_room_shares 的 DDL 单一来源（双挂点：wdfpData 初始化器 + 
 * openSharedSocialDb，与 social_follows/attention 同模式）。
 *
 * 好友房间大厅的招募房间注册表：share_room 持久化房主选择的可见性位
 * （bit1=双向关注 bit2=单向关注；bit3=随机招募走 attention_recruitments，
 * 不入此表），get_rooms 按 category 拉取并按请求者与房主的真实 follow
 * 关系过滤。行由房间权威节点的生命周期钩子（syncRoomShareRow / disband
 * listener）实时维护，expires_at 只兜房主异常退出的兜底。
 */
export function ensureSocialRoomSharesSchema(database: Database): void {
    database.prepare(`CREATE TABLE IF NOT EXISTS social_room_shares (
        room_number TEXT PRIMARY KEY,
        host_viewer_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        share_bits INTEGER NOT NULL,
        raising_state INTEGER NOT NULL,
        mates INTEGER NOT NULL,
        establisher_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_social_room_shares_category
        ON social_room_shares (category_id, raising_state, expires_at)`).run()
}
