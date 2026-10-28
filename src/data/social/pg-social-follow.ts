import type { Pool } from "pg"
import type { SharedFollowRelation } from "../domains/social-follow"
import { getNodeNamespace } from "./pg"

/**
 * social_follows 的 PG 实现（W1b，跨物理机）。行为契约与共享 SQLite 版
 * 等价（契约矩阵测试 W1c 落地）：mutual = 双行、single = 单行、none = 零行；
 * 查询失败 fail-closed 为 none（好友大厅可见性过滤依据）。
 * 全部行携带 node_id 命名空间（W1c）。
 */

type PgClient = Pool

export async function upsertSharedFollowEdgePg(
    pool: PgClient,
    nodeId: string,
    followerViewerId: number,
    followedViewerId: number,
    followedAtMs: number,
): Promise<void> {
    if (followerViewerId === followedViewerId) return
    await pool.query(
        `INSERT INTO social_follows (node_id, follower_viewer_id, followed_viewer_id, followed_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (node_id, follower_viewer_id, followed_viewer_id) DO UPDATE SET
             followed_at_ms = excluded.followed_at_ms`,
        [nodeId, followerViewerId, followedViewerId, followedAtMs],
    )
}

export async function deleteSharedFollowEdgePg(
    pool: PgClient,
    nodeId: string,
    followerViewerId: number,
    followedViewerId: number,
): Promise<void> {
    if (followerViewerId === followedViewerId) return
    await pool.query(
        `DELETE FROM social_follows
         WHERE node_id = $1 AND follower_viewer_id = $2 AND followed_viewer_id = $3`,
        [nodeId, followerViewerId, followedViewerId],
    )
}

export async function getSharedFollowRelationPg(
    pool: PgClient,
    nodeId: string,
    followerViewerId: number,
    followedViewerId: number,
): Promise<SharedFollowRelation> {
    if (followerViewerId === followedViewerId) return "none"
    try {
        const result = await pool.query(
            `SELECT follower_viewer_id FROM social_follows
             WHERE node_id = $1
                 AND ((follower_viewer_id = $2 AND followed_viewer_id = $3)
                     OR (follower_viewer_id = $3 AND followed_viewer_id = $2))`,
            [nodeId, followerViewerId, followedViewerId],
        )
        if (result.rowCount !== null && result.rowCount >= 2) return "mutual"
        if (result.rowCount === 1) return "single"
        return "none"
    } catch (error) {
        console.warn("[SOCIAL-FOLLOW] shared relation lookup failed", error)
        return "none"
    }
}
