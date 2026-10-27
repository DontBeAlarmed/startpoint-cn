import type { Pool } from "pg"
import { getNodeNamespace } from "./pg"

/**
 * social_room_shares 的 PG 实现（W1b，跨物理机）。行为契约与共享 SQLite 版
 * 等价（契约矩阵锁定）：位掩码 OR-merge（已公开位永不收缩）、refresh 对
 * 不存在的行 no-op、list 按 updated_at DESC 且只含 (share_bits & 3) != 0 的
 * 未过期行。全部行携带 node_id 命名空间（W1c）。
 */

export interface PgRoomShareUpsertInput {
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

export interface PgRoomShareRow {
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

const SOCIAL_ROOM_SHARE_TTL_MS = 30 * 60_000

export function createPgRoomShareStore(pool: Pool, nodeId: string) {
    return {
        async upsertRoomShareRow(input: PgRoomShareUpsertInput): Promise<void> {
            await pool.query(
                `INSERT INTO social_room_shares (
                    node_id, room_number, host_viewer_id, category_id, quest_id,
                    share_bits, raising_state, mates, establisher_json,
                    created_at_ms, updated_at_ms, expires_at_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
                ON CONFLICT (node_id, room_number) DO UPDATE SET
                    share_bits = social_room_shares.share_bits | excluded.share_bits,
                    host_viewer_id = excluded.host_viewer_id,
                    category_id = excluded.category_id,
                    quest_id = excluded.quest_id,
                    raising_state = excluded.raising_state,
                    mates = excluded.mates,
                    establisher_json = excluded.establisher_json,
                    updated_at_ms = excluded.updated_at_ms,
                    expires_at_ms = excluded.expires_at_ms`,
                [nodeId, input.roomNumber, input.hostViewerId, input.categoryId,
                    input.questId, input.shareBits, input.raisingState, input.mates,
                    input.establisherJson, input.nowMs, input.nowMs + SOCIAL_ROOM_SHARE_TTL_MS],
            )
        },

        async refreshRoomShareRow(roomNumber: string, raisingState: number, mates: number, nowMs: number): Promise<void> {
            try {
                await pool.query(
                    `UPDATE social_room_shares
                     SET raising_state = $1, mates = $2, updated_at_ms = $3, expires_at_ms = $4
                     WHERE node_id = $5 AND room_number = $6`,
                    [raisingState, mates, nowMs, nowMs + SOCIAL_ROOM_SHARE_TTL_MS, nodeId, roomNumber],
                )
            } catch (error) {
                console.warn("[SOCIAL-SHARE] room share refresh failed", roomNumber, error)
            }
        },

        async deleteRoomShareRow(roomNumber: string): Promise<void> {
            try {
                await pool.query(
                    `DELETE FROM social_room_shares WHERE node_id = $1 AND room_number = $2`,
                    [nodeId, roomNumber],
                )
            } catch (error) {
                console.warn("[SOCIAL-SHARE] room share delete failed", roomNumber, error)
            }
        },

        async listActiveRoomShares(categoryId: number, nowMs: number): Promise<readonly PgRoomShareRow[]> {
            const result = await pool.query(
                `SELECT room_number, host_viewer_id, category_id, quest_id, share_bits,
                     raising_state, mates, establisher_json, expires_at_ms
                 FROM social_room_shares
                 WHERE node_id = $1 AND category_id = $2 AND expires_at_ms > $3
                     AND (share_bits & 3) != 0
                 ORDER BY updated_at_ms DESC`,
                [nodeId, categoryId, nowMs],
            )
            return result.rows.map(row => ({
                room_number: String(row.room_number),
                host_viewer_id: Number(row.host_viewer_id),
                category_id: Number(row.category_id),
                quest_id: Number(row.quest_id),
                share_bits: Number(row.share_bits),
                raising_state: Number(row.raising_state),
                mates: Number(row.mates),
                establisher_json: String(row.establisher_json),
                expires_at_ms: Number(row.expires_at_ms),
            }))
        },

        async getRoomShareRow(roomNumber: string): Promise<PgRoomShareRow | undefined> {
            const result = await pool.query(
                `SELECT room_number, host_viewer_id, category_id, quest_id, share_bits,
                     raising_state, mates, establisher_json, expires_at_ms
                 FROM social_room_shares
                 WHERE node_id = $1 AND room_number = $2`,
                [nodeId, roomNumber],
            )
            return result.rows.length > 0
                ? {
                    room_number: String(result.rows[0].room_number),
                    host_viewer_id: Number(result.rows[0].host_viewer_id),
                    category_id: Number(result.rows[0].category_id),
                    quest_id: Number(result.rows[0].quest_id),
                    share_bits: Number(result.rows[0].share_bits),
                    raising_state: Number(result.rows[0].raising_state),
                    mates: Number(result.rows[0].mates),
                    establisher_json: String(result.rows[0].establisher_json),
                    expires_at_ms: Number(result.rows[0].expires_at_ms),
                }
                : undefined
        },
    }
}
