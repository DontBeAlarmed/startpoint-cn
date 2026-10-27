/**
 * 在线状态（键空间 viewer_id——铃铛投递/检查全链路的协议主键）。
 * A1 来源：/attention/check 轮询 touch（原版客户端不加新请求）。
 *
 * presence 度量"进程存活"，属真实时钟域：默认经 getRealNowMs() 取时。
 * 禁止传入虚拟钟（getServerTime 域，默认偏移约 2 年）——混用会得到
 * 永久在线/永久离线的错判。
 * 上报节流 30s 与在线判定窗口 5min 是两个独立常量（对齐参考服
 * online-presence 的双常量语义，非"窗口=节流"）。
 *
 * A2 存储形态（PresenceStore 接口，W1a 起全异步——PG 后端 W1b 的接入前提）：
 * - 默认：节点内内存 Map，零持久化零开销（单进程部署与 A1 行为一致）；
 * - 共享：设置 MULTI_SOCIAL_DB_PATH 后走共享社交库 social_presence 表，
 *   多节点/多进程平等读写（各进程独立连接，WAL + busy_timeout）；
 * - PG：设置 MULTI_SOCIAL_PG_URL 后走 PG 后端（W1b）。
 *
 * 同步上下文（TCP 帧处理）调用约定：写路径 fire-and-forget（`void` +
 * 忽略错误，presence 容忍秒级可见性延迟）；读路径必须 await。
 */
import type { Database } from "better-sqlite3"
import { getRealNowMs } from "../runtime/time/game-time"
import { getSharedSocialDb } from "../data/social/shared-db"

export const PRESENCE_THROTTLE_MS = 30_000
export const PRESENCE_WINDOW_MS = 5 * 60_000

// 免疫长期缓涨：历史条目超过阈值时，touch 顺带清扫早已过期的 viewer
const PRESENCE_SWEEP_THRESHOLD = 1024

export interface PresenceStore {
    touch(viewerId: number, nowMs?: number): Promise<void>
    isOnline(viewerId: number, nowMs?: number): Promise<boolean>
    onlineViewerIds(nowMs?: number): Promise<number[]>
}

/** 节点内内存实现（默认）：零持久化 */
export function createMemoryPresenceStore(): PresenceStore {
    const presenceMap = new Map<number, number>()
    return {
        async touch(viewerId, nowMs = getRealNowMs()) {
            const last = presenceMap.get(viewerId)
            if (last !== undefined && nowMs - last < PRESENCE_THROTTLE_MS) return
            presenceMap.set(viewerId, nowMs)
            if (presenceMap.size > PRESENCE_SWEEP_THRESHOLD) {
                for (const [staleViewerId, seen] of presenceMap) {
                    if (nowMs - seen >= PRESENCE_WINDOW_MS) presenceMap.delete(staleViewerId)
                }
            }
        },
        async isOnline(viewerId, nowMs = getRealNowMs()) {
            const last = presenceMap.get(viewerId)
            return last !== undefined && nowMs - last < PRESENCE_WINDOW_MS
        },
        async onlineViewerIds(nowMs = getRealNowMs()) {
            const result: number[] = []
            for (const [viewerId, last] of presenceMap) {
                if (nowMs - last < PRESENCE_WINDOW_MS) result.push(viewerId)
            }
            return result
        },
    }
}

/** 共享社交库实现：social_presence 表 TTL（touch 30s 节流 + 5min 窗口 + 惰性清扫）。
 * better-sqlite3 为同步 API——实现为 async 形状以符合统一接口（微任务直返）。 */
export function createSqlitePresenceStore(db: Database): PresenceStore {
    return {
        async touch(viewerId, nowMs = getRealNowMs()) {
            const last = db.prepare(
                "SELECT last_seen_ms FROM social_presence WHERE viewer_id = ?",
            ).get(viewerId) as { last_seen_ms: number } | undefined
            if (last !== undefined && nowMs - last.last_seen_ms < PRESENCE_THROTTLE_MS) return
            db.prepare(`
                INSERT INTO social_presence (viewer_id, last_seen_ms) VALUES (?, ?)
                ON CONFLICT(viewer_id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms
            `).run(viewerId, nowMs)
            // 惰性清扫（表大小 = 并发在线 viewer 数，量级小，全删扫描可接受）
            db.prepare("DELETE FROM social_presence WHERE last_seen_ms <= ?")
                .run(nowMs - PRESENCE_WINDOW_MS)
        },
        async isOnline(viewerId, nowMs = getRealNowMs()) {
            const row = db.prepare(
                "SELECT last_seen_ms FROM social_presence WHERE viewer_id = ?",
            ).get(viewerId) as { last_seen_ms: number } | undefined
            return row !== undefined && nowMs - row.last_seen_ms < PRESENCE_WINDOW_MS
        },
        async onlineViewerIds(nowMs = getRealNowMs()) {
            const rows = db.prepare(
                "SELECT viewer_id FROM social_presence WHERE last_seen_ms > ? ORDER BY viewer_id",
            ).all(nowMs - PRESENCE_WINDOW_MS) as Array<{ viewer_id: number }>
            return rows.map(row => Number(row.viewer_id))
        },
    }
}

let configuredPresenceStore: PresenceStore | null = null

/** 进程级单例：MULTI_SOCIAL_DB_PATH 设置 → 共享表；否则内存 Map */
export function getPresenceStore(): PresenceStore {
    if (configuredPresenceStore === null) {
        const shared = getSharedSocialDb()
        configuredPresenceStore = shared !== null
            ? createSqlitePresenceStore(shared)
            : createMemoryPresenceStore()
    }
    return configuredPresenceStore
}

// ---- 兼容层：A1 的模块级函数导出（W1a 起为异步形状） ----

export async function touchPresence(viewerId: number, nowMs?: number): Promise<void> {
    await getPresenceStore().touch(viewerId, nowMs)
}

export async function isPresenceOnline(viewerId: number, nowMs?: number): Promise<boolean> {
    return getPresenceStore().isOnline(viewerId, nowMs)
}

export async function onlineViewerIds(nowMs?: number): Promise<number[]> {
    return getPresenceStore().onlineViewerIds(nowMs)
}
