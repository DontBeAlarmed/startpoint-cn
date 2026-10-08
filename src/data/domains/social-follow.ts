import { getDb } from "../db"
import { getSharedSocialDb } from "../social/shared-db"
import { ensureSocialFollowsSchema } from "../social/social-follows-schema"

/**
 * 共享 follow 边副本（social_follows）的读写 API。
 *
 * 存储选择（A2 双形态）：配置 MULTI_SOCIAL_DB_PATH 时走共享社交库（多节点
 * 等权读写）；否则退主库——两条路径的表结构由 ensureSocialFollowsSchema
 * 保证一致，主库表在 wdfpData 初始化器建好，共享库表在 openSharedSocialDb
 * 建好。读写统一走本模块，调用方不需要关心形态。
 *
 * 写入是本地 players_follows 的尽力而为副本（调用方负责 WARN 降级）；
 * 读取是好友房间大厅可见性过滤的依据，fail-closed（查不到=无关系）。
 */

export type SharedFollowRelation = "mutual" | "single" | "none"

function socialFollowsDatabase() {
    const shared = getSharedSocialDb()
    if (shared !== null) return shared
    const main = getDb()
    ensureSocialFollowsSchema(main)
    return main
}

/** 单边 upsert（follower → followed）；失败由调用方降级 WARN */
export function upsertSharedFollowEdgeSync(
    followerViewerId: number,
    followedViewerId: number,
    followedAtMs: number,
): void {
    if (followerViewerId === followedViewerId) return
    socialFollowsDatabase().prepare(`
        INSERT INTO social_follows (follower_viewer_id, followed_viewer_id, followed_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(follower_viewer_id, followed_viewer_id) DO UPDATE SET
            followed_at_ms = excluded.followed_at_ms
    `).run(followerViewerId, followedViewerId, followedAtMs)
}

/** 单边删除；不存在时静默（幂等） */
export function deleteSharedFollowEdgeSync(
    followerViewerId: number,
    followedViewerId: number,
): void {
    if (followerViewerId === followedViewerId) return
    socialFollowsDatabase().prepare(`
        DELETE FROM social_follows
        WHERE follower_viewer_id = ? AND followed_viewer_id = ?
    `).run(followerViewerId, followedViewerId)
}

/**
 * 双向关系判定（好友房间大厅可见性过滤依据）：
 * 两行=mutual，恰一行=single，零行=none。查询失败 fail-closed 为 none。
 */
export function getSharedFollowRelationSync(
    followerViewerId: number,
    followedViewerId: number,
): SharedFollowRelation {
    if (followerViewerId === followedViewerId) return "none"
    try {
        const rows = socialFollowsDatabase().prepare(`
            SELECT follower_viewer_id, followed_viewer_id FROM social_follows
            WHERE (follower_viewer_id = ? AND followed_viewer_id = ?)
               OR (follower_viewer_id = ? AND followed_viewer_id = ?)
        `).all(followerViewerId, followedViewerId, followedViewerId, followerViewerId) as unknown[]
        if (rows.length >= 2) return "mutual"
        if (rows.length === 1) return "single"
        return "none"
    } catch (error) {
        console.warn("[SOCIAL-FOLLOW] shared relation lookup failed", error)
        return "none"
    }
}
