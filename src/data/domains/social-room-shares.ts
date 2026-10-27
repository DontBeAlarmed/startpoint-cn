import { getDb } from "../db"
import { getSharedSocialDb } from "../social/shared-db"
import { ensureSocialRoomSharesSchema } from "../social/social-room-shares-schema"

/**
 * social_room_shares 注册表读写（好友房间大厅数据源）。
 *
 * 双形态（A2 同款）：配置 MULTI_SOCIAL_DB_PATH 走共享社交库（多节点可见），
 * 否则退主库。可见性位 OR-merge 在 SQL 层完成——share_type_list 的到达顺序
 * 不可控（[1] 与 15s 恒发的 [3] 交错），REPLACE 会静默收缩已公开的位。
 * 生命周期刷新（refreshRoomShareRow）对不存在的行是 no-op：未开放列表可见
 * 的房没有注册行，钩子静默跳过。
 */

export const SOCIAL_ROOM_SHARE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.SOCIAL_ROOM_SHARE_TTL_MS ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000
})()

export interface RoomShareUpsertInput {
    readonly roomNumber: string
    readonly hostViewerId: number
    readonly categoryId: number
    readonly questId: number
    readonly shareBits: number
    readonly raisingState: number
    readonly mates: number
    readonly establisherJson: string
    readonly nowMs: number
}

export interface RoomShareRow {
    readonly room_number: string
    readonly host_viewer_id: number
    readonly category_id: number
    readonly quest_id: number
    readonly share_bits: number
    readonly raising_state: number
    readonly mates: number
    readonly establisher_json: string
    readonly expires_at_ms: number
}

function roomSharesDatabase() {
    const shared = getSharedSocialDb()
    if (shared !== null) return shared
    const main = getDb()
    ensureSocialRoomSharesSchema(main)
    return main
}

/** 位掩码 OR-merge upsert（SQL 层保证已公开位永不收缩） */
export function upsertRoomShareRowSync(input: RoomShareUpsertInput): void {
    const expiresAtMs = input.nowMs + SOCIAL_ROOM_SHARE_TTL_MS
    roomSharesDatabase().prepare(`
        INSERT INTO social_room_shares (
            room_number, host_viewer_id, category_id, quest_id, share_bits,
            raising_state, mates, establisher_json, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_number) DO UPDATE SET
            share_bits = share_bits | excluded.share_bits,
            host_viewer_id = excluded.host_viewer_id,
            category_id = excluded.category_id,
            quest_id = excluded.quest_id,
            raising_state = excluded.raising_state,
            mates = excluded.mates,
            establisher_json = excluded.establisher_json,
            updated_at_ms = excluded.updated_at_ms,
            expires_at_ms = excluded.expires_at_ms
    `).run(
        input.roomNumber,
        input.hostViewerId,
        input.categoryId,
        input.questId,
        input.shareBits,
        input.raisingState,
        input.mates,
        input.establisherJson,
        input.nowMs,
        input.nowMs,
        expiresAtMs,
    )
}

/**
 * 生命周期刷新（raising_state/mates 变化钩子）：行不存在时 no-op；
 * 每次刷新同时续期 expires_at（长战斗+再战可超 TTL）。
 */
export function refreshRoomShareRowSync(
    roomNumber: string,
    raisingState: number,
    mates: number,
    nowMs: number,
): void {
    try {
        roomSharesDatabase().prepare(`
            UPDATE social_room_shares
            SET raising_state = ?, mates = ?, updated_at_ms = ?, expires_at_ms = ?
            WHERE room_number = ?
        `).run(raisingState, mates, nowMs, nowMs + SOCIAL_ROOM_SHARE_TTL_MS, roomNumber)
    } catch (error) {
        console.warn("[SOCIAL-SHARE] room share refresh failed", roomNumber, error)
    }
}

/** 解散/清理钩子：删除注册行（幂等） */
/** 启动清扫：删除本地库全部注册行（仅本地权威启动态调用，见 startup-sweep.ts）。
 * 返回删除行数。 */
export function purgeAllRoomShareRowsSync(): number {
    const result = getDb().prepare(`DELETE FROM social_room_shares`).run()
    return result.changes
}

export function deleteRoomShareRowSync(roomNumber: string): void {
    try {
        roomSharesDatabase().prepare(`
            DELETE FROM social_room_shares WHERE room_number = ?
        `).run(roomNumber)
    } catch (error) {
        console.warn("[SOCIAL-SHARE] room share delete failed", roomNumber, error)
    }
}

/** get_rooms 数据源：同 category、未过期的注册行 */
export function listActiveRoomSharesSync(categoryId: number, nowMs: number): readonly RoomShareRow[] {
    return roomSharesDatabase().prepare(`
        SELECT room_number, host_viewer_id, category_id, quest_id, share_bits,
               raising_state, mates, establisher_json, expires_at_ms
        FROM social_room_shares
        WHERE category_id = ? AND expires_at_ms > ? AND (share_bits & 3) != 0
        ORDER BY updated_at_ms DESC
    `).all(categoryId, nowMs) as readonly RoomShareRow[]
}

/** 测试用：直接读单行 */
export function getRoomShareRowSync(roomNumber: string): RoomShareRow | undefined {
    return roomSharesDatabase().prepare(`
        SELECT room_number, host_viewer_id, category_id, quest_id, share_bits,
               raising_state, mates, establisher_json, expires_at_ms
        FROM social_room_shares WHERE room_number = ?
    `).get(roomNumber) as RoomShareRow | undefined
}
