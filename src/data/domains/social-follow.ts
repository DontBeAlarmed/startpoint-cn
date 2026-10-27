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
 * W1a：API 异步形状（接口级，SQLite 实现为微任务直返）；PG 后端 W1b。
 */

export type SharedFollowRelation = "mutual" | "single" | "none"

function socialFollowsDatabase() {
    const shared = getSharedSocialDb()
    if (shared !== null) return shared
    const main = getDb()
    ensureSocialFollowsSchema(main)
    return main
}

/** 单边 upsert（follower → followed）；失败由调用方降级 WARN。
 * W1a 起异步形状（PG 后端 W1b 接入前提）；同步上下文写路径 fire-and-forget。 */
export async function upsertSharedFollowEdgeAsync(
    followerViewerId: number,
    followedViewerId: number,
    followedAtMs: number,
): Promise<void> {
    if (followerViewerId === followedViewerId) return
    socialFollowsDatabase().prepare(`
        INSERT INTO social_follows (follower_viewer_id, followed_viewer_id, followed_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(follower_viewer_id, followed_viewer_id) DO UPDATE SET
            coop_bonus_count = 0,
            followed_at_ms = excluded.followed_at_ms
    `).run(followerViewerId, followedViewerId, followedAtMs)
}

/**
 * 关注奖励计数读取（v4）：viewer 对 followedIds 中已存在方向行的累计奖励分。
 * 行不存在 = 无关注边 = 无奖励（返回值缺键）。行即记录：取关删行即清零。
 */
export function getCoopBonusCountsSync(
    followerViewerId: number,
    followedViewerIds: readonly number[],
): Record<number, number> {
    const out: Record<number, number> = {}
    if (followedViewerIds.length === 0) return out
    const placeholders = followedViewerIds.map(() => "?").join(", ")
    const rows = socialFollowsDatabase().prepare(`
    SELECT followed_viewer_id, coop_bonus_count
    FROM social_follows
    WHERE follower_viewer_id = ? AND followed_viewer_id IN (${placeholders})
    `).all(followerViewerId, ...followedViewerIds) as Array<{
        followed_viewer_id: number
        coop_bonus_count: number
    }>
    for (const row of rows) out[row.followed_viewer_id] = row.coop_bonus_count ?? 0
    return out
}

/** 开战配对增量：单事务批量 +10（钳 1e6）；方向行不存在时静默跳过（无关注边不记账） */
export function incrementCoopBonusCountsSync(
    pairs: readonly { readonly followerViewerId: number; readonly followedViewerId: number }[],
): void {
    if (pairs.length === 0) return
    const database = socialFollowsDatabase()
    const increment = database.prepare(`
    UPDATE social_follows
    SET coop_bonus_count = MIN(coop_bonus_count + 10, 1000000)
    WHERE follower_viewer_id = ? AND followed_viewer_id = ?
    `)
    const run = database.transaction(() => {
        for (const pair of pairs) {
            if (pair.followerViewerId === pair.followedViewerId) continue
            increment.run(pair.followerViewerId, pair.followedViewerId)
        }
    })
    run()
}

/** 单边删除；不存在时静默（幂等）。取关同时清除该方向行的关注奖励计数（行即记录） */
export async function deleteSharedFollowEdgeAsync(

    followerViewerId: number,
    followedViewerId: number,
): Promise<void> {
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
export async function getSharedFollowRelationAsync(
    followerViewerId: number,
    followedViewerId: number,
): Promise<SharedFollowRelation> {
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
