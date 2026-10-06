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
 * A2 存储形态（PresenceStore 接口）：
 * - 默认：节点内内存 Map，零持久化零开销（单进程部署与 A1 行为一致）；
 * - 共享：设置 MULTI_SOCIAL_DB_PATH 后走共享社交库 social_presence 表，
 *   多节点/多进程平等读写（各进程独立连接，WAL + busy_timeout）。
 */
import type { Database } from "better-sqlite3"
import { getRealNowMs } from "../runtime/time/game-time"
import { getSharedSocialDb } from "../data/social/shared-db"

export const PRESENCE_THROTTLE_MS = 30_000
export const PRESENCE_WINDOW_MS = 5 * 60_000

// 免疫长期缓涨：历史条目超过阈值时，touch 顺带清扫早已过期的 viewer
const PRESENCE_SWEEP_THRESHOLD = 1024

export interface PresenceStore {
    touch(viewerId: number, nowMs?: number): void
    isOnline(viewerId: number, nowMs?: number): boolean
    onlineViewerIds(nowMs?: number): number[]
}

/** 节点内内存实现（默认）：零持久化 */
export function createMemoryPresenceStore(): PresenceStore {
    const presenceMap = new Map<number, number>()
    return {
        touch(viewerId, nowMs = getRealNowMs()) {
            const last = presenceMap.get(viewerId)
            if (last !== undefined && nowMs - last < PRESENCE_THROTTLE_MS) return
            presenceMap.set(viewerId, nowMs)
            if (presenceMap.size > PRESENCE_SWEEP_THRESHOLD) {
                for (const [staleViewerId, seen] of presenceMap) {
                    if (nowMs - seen >= PRESENCE_WINDOW_MS) presenceMap.delete(staleViewerId)
                }
            }
        },
        isOnline(viewerId, nowMs = getRealNowMs()) {
            const last = presenceMap.get(viewerId)
            return last !== undefined && nowMs - last < PRESENCE_WINDOW_MS
        },
        onlineViewerIds(nowMs = getRealNowMs()) {
            const result: number[] = []
            for (const [viewerId, last] of presenceMap) {
                if (nowMs - last < PRESENCE_WINDOW_MS) result.push(viewerId)
            }
            return result
        },
    }
}

/** 共享社交库实现：social_presence 表 TTL（touch 30s 节流 + 5min 窗口 + 惰性清扫） */
export function createSqlitePresenceStore(db: Database): PresenceStore {
    return {
        touch(viewerId, nowMs = getRealNowMs()) {
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
        isOnline(viewerId, nowMs = getRealNowMs()) {
            const row = db.prepare(
                "SELECT last_seen_ms FROM social_presence WHERE viewer_id = ?",
            ).get(viewerId) as { last_seen_ms: number } | undefined
            return row !== undefined && nowMs - row.last_seen_ms < PRESENCE_WINDOW_MS
        },
        onlineViewerIds(nowMs = getRealNowMs()) {
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

// ---- 兼容层：保持 A1 的模块级函数导出（调用点与既有测试零改动） ----

export function touchPresence(viewerId: number, nowMs?: number): void {
    getPresenceStore().touch(viewerId, nowMs)
}

export function isPresenceOnline(viewerId: number, nowMs?: number): boolean {
    return getPresenceStore().isOnline(viewerId, nowMs)
}

export function onlineViewerIds(nowMs?: number): number[] {
    return getPresenceStore().onlineViewerIds(nowMs)
}
