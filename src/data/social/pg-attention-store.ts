import type { Pool, PoolClient } from "pg"
import type { AttentionRecruitment, AttentionStore } from "../domains/attention"
import { buildEstablisherSnapshot, getRecruitmentLifetimeMs, parseEstablisherSnapshot } from "../domains/attention"

/**
 * AttentionStore 的 PG 实现（W1b，跨物理机）。行为契约与共享 SQLite 版
 * 与共享 SQLite 版行为等价（契约矩阵测试 W1c 落地）：
 * - 两步投递契约（listUndelivered 不烧行 + recordDeliveries 幂等记帐）
 * - 每招募每 viewer 只投递一次（d.state IS NULL 谓词）
 * - get-or-create 同 (node, 房主, 房间) 恒定 key，重发只刷新
 * - recordResponse 单向转移（仅 delivered 可变）
 * - 全部行携带 node_id 命名空间（W1c）
 */

function mapRecruitmentRow(row: Record<string, unknown>): AttentionRecruitment {
    return {
        id: Number(row.id),
        attentionKey: String(row.attention_key),
        roomNumber: String(row.room_number),
        hostPid: Number(row.host_pid),
        hostViewerId: Number(row.host_viewer_id),
        category: Number(row.category),
        questId: Number(row.quest_id),
        isNewbieHost: Number(row.is_newbie_host) !== 0,
        establisherJson: String(row.establisher_json),
        postedAtMs: Number(row.posted_at_ms),
        expiresAtMs: Number(row.expires_at_ms),
        status: String(row.status) as "open" | "closed" | "expired",
    }
}

const RECRUITMENT_COLUMNS = `id, node_id, attention_key, room_number, host_pid, host_viewer_id,
    category, quest_id, is_newbie_host, establisher_json, posted_at_ms, expires_at_ms, status`

export function createPgAttentionStore(nodeId: string, pool: Pool): AttentionStore {
    return {
        async getOrCreateRecruitmentForRoom(input) {
            const client = await pool.connect()
            try {
                await client.query("BEGIN")
                const existing = await client.query(
                    `SELECT id, attention_key FROM attention_recruitments
                     WHERE node_id = $1 AND host_viewer_id = $2 AND room_number = $3
                         AND status = 'open' AND expires_at_ms > $4
                     LIMIT 1`,
                    [nodeId, input.hostViewerId, input.roomNumber, input.nowMs],
                )
                if (existing.rows.length > 0) {
                    const row = existing.rows[0]
                    await client.query(
                        `UPDATE attention_recruitments
                         SET category = $1, quest_id = $2, is_newbie_host = $3,
                             establisher_json = $4, expires_at_ms = $5
                         WHERE id = $6`,
                        [input.category, input.questId, input.isNewbieHost ? 1 : 0,
                            input.establisherJson, input.nowMs + getRecruitmentLifetimeMs(), row.id],
                    )
                    await client.query("COMMIT")
                    return { id: Number(row.id), attentionKey: String(row.attention_key), created: false }
                }
                let key = ""
                let inserted = null
                // UNIQUE(node_id, attention_key) 碰撞：换随机数重试 ×3（对齐
                // SQLite 版，避免历史残留 key 让当轮分享降级）
                for (let attempt = 0; attempt < 3; attempt++) {
                    key = `attention_${String(Math.floor(100000 + Math.random() * 900000))}_${nodeId}`
                    try {
                        inserted = await client.query(
                            `INSERT INTO attention_recruitments
                                (node_id, attention_key, room_number, host_pid, host_viewer_id,
                                 category, quest_id, is_newbie_host, establisher_json,
                                 posted_at_ms, expires_at_ms, status)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')
                             RETURNING id`,
                            [nodeId, key, input.roomNumber, input.hostPid, input.hostViewerId,
                                input.category, input.questId, input.isNewbieHost ? 1 : 0,
                                input.establisherJson, input.nowMs, input.nowMs + getRecruitmentLifetimeMs()],
                        )
                        break
                    } catch (error) {
                        if (attempt === 2) throw error
                    }
                }
                await client.query("COMMIT")
                return { id: Number(inserted!.rows[0].id), attentionKey: key, created: true }
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {})
                throw error
            } finally {
                client.release()
            }
        },

        async listUndeliveredOpenRecruitments(viewerId, nowMs, limit) {
            const result = await pool.query(
                `SELECT ${RECRUITMENT_COLUMNS} FROM attention_recruitments r
                 LEFT JOIN attention_deliveries d
                     ON d.recruitment_id = r.id AND d.viewer_id = $1
                 WHERE r.node_id = $2 AND r.status = 'open' AND r.expires_at_ms > $3
                     AND r.host_viewer_id != $1
                     AND d.state IS NULL
                 ORDER BY r.posted_at_ms DESC
                 LIMIT $4`,
                [viewerId, nodeId, nowMs, limit],
            )
            return result.rows.map((row: Record<string, unknown>) => mapRecruitmentRow(row))
        },

        async recordDeliveries(viewerId, recruitmentIds) {
            for (const id of recruitmentIds) {
                await pool.query(
                    `INSERT INTO attention_deliveries (recruitment_id, viewer_id, state)
                     VALUES ($1, $2, 'delivered') ON CONFLICT DO NOTHING`,
                    [id, viewerId],
                )
            }
        },

        async findOpenRecruitmentByKey(attentionKey, nowMs) {
            const result = await pool.query(
                `SELECT ${RECRUITMENT_COLUMNS} FROM attention_recruitments
                 WHERE node_id = $1 AND attention_key = $2 AND status = 'open' AND expires_at_ms > $3
                 LIMIT 1`,
                [nodeId, attentionKey, nowMs],
            )
            return result.rows.length > 0 ? mapRecruitmentRow(result.rows[0] as Record<string, unknown>) : null
        },

        async findOpenRecruitmentForRoom(hostViewerId, roomNumber, nowMs, includeExpired = false) {
            const expiryFilter = includeExpired ? "" : "AND expires_at_ms > $4"
            const params = includeExpired
                ? [nodeId, hostViewerId, roomNumber]
                : [nodeId, hostViewerId, roomNumber, nowMs]
            const result = await pool.query(
                `SELECT ${RECRUITMENT_COLUMNS} FROM attention_recruitments
                 WHERE node_id = $1 AND host_viewer_id = $2 AND room_number = $3 AND status = 'open'
                     ${expiryFilter}
                 ORDER BY posted_at_ms DESC LIMIT 1`,
                params,
            )
            return result.rows.length > 0 ? mapRecruitmentRow(result.rows[0] as Record<string, unknown>) : null
        },

        async hasActiveDelivery(recruitmentId, viewerId) {
            const result = await pool.query(
                `SELECT 1 FROM attention_deliveries
                 WHERE recruitment_id = $1 AND viewer_id = $2 AND state != 'declined'
                 LIMIT 1`,
                [recruitmentId, viewerId],
            )
            return result.rowCount !== 0
        },

        async recordResponse(recruitmentId, viewerId, state, nowMs) {
            await pool.query(
                `UPDATE attention_deliveries SET state = $1, acted_at_ms = $2
                 WHERE recruitment_id = $3 AND viewer_id = $4 AND state = 'delivered'`,
                [state, nowMs, recruitmentId, viewerId],
            )
        },

        async closeRecruitmentForRoom(hostViewerId, roomNumber) {
            await pool.query(
                `UPDATE attention_recruitments SET status = 'closed'
                 WHERE node_id = $1 AND host_viewer_id = $2 AND room_number = $3 AND status = 'open'`,
                [nodeId, hostViewerId, roomNumber],
            )
        },

        async refreshRecruitmentForRoom(hostViewerId, roomNumber, nowMs, lifetimeMs) {
            await pool.query(
                `UPDATE attention_recruitments SET expires_at_ms = $1
                 WHERE node_id = $2 AND host_viewer_id = $3 AND room_number = $4
                     AND status = 'open' AND expires_at_ms > $5`,
                [nowMs + lifetimeMs, nodeId, hostViewerId, roomNumber, nowMs],
            )
        },

        async updateOpenRecruitmentSnapshotForRoom(hostPid, hostViewerId, roomNumber, nowMs, patch) {
            const client = await pool.connect()
            try {
                const row = await client.query(
                    `SELECT id, establisher_json FROM attention_recruitments
                     WHERE node_id = $1 AND host_pid = $2 AND host_viewer_id = $3
                         AND room_number = $4 AND status = 'open' AND expires_at_ms > $5
                     LIMIT 1`,
                    [nodeId, hostPid, hostViewerId, roomNumber, nowMs],
                )
                if (row.rows.length === 0) return
                const parsed = parseEstablisherSnapshot(row.rows[0].establisher_json)
                await client.query(
                    `UPDATE attention_recruitments SET establisher_json = $1 WHERE id = $2`,
                    [buildEstablisherSnapshot({
                        character: patch.character,
                        rankLevel: parsed.rankLevel,
                        hostEntryTime: parsed.hostEntryTime,
                        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
                        evolutionImgLevel: patch.evolutionImgLevel,
                    }), row.rows[0].id],
                )
            } finally {
                client.release()
            }
        },

        async listOpenRecruitmentRoomNumbersForHost(hostPid, hostViewerId, nowMs) {
            const result = await pool.query(
                `SELECT room_number FROM attention_recruitments
                 WHERE node_id = $1 AND host_pid = $2 AND host_viewer_id = $3
                     AND status = 'open' AND expires_at_ms > $4`,
                [nodeId, hostPid, hostViewerId, nowMs],
            )
            return result.rows.map(row => String(row.room_number))
        },

        async closeAllOpenRecruitments() {
            await pool.query(
                `UPDATE attention_recruitments SET status = 'closed'
                 WHERE node_id = $1 AND status = 'open'`,
                [nodeId],
            )
        },

        async expireStaleRecruitments(nowMs) {
            await pool.query(
                `UPDATE attention_recruitments SET status = 'expired'
                 WHERE node_id = $1 AND status = 'open' AND expires_at_ms <= $2`,
                [nodeId, nowMs],
            )
        },

        async pruneExpiredRecruitments(nowMs, retentionMs = 24 * 60 * 60 * 1000) {
            await pool.query(
                `UPDATE attention_recruitments SET status = 'expired'
                 WHERE node_id = $1 AND status = 'open' AND expires_at_ms <= $2`,
                [nodeId, nowMs],
            )
            const expired = await pool.query(
                `DELETE FROM attention_recruitments
                 WHERE node_id = $1 AND expires_at_ms < $2 AND status != 'open'
                 RETURNING id`,
                [nodeId, nowMs - retentionMs],
            )
            for (const row of expired.rows) {
                await pool.query(
                    `DELETE FROM attention_deliveries WHERE recruitment_id = $1`,
                    [row.id],
                )
            }
        },
    }
}
