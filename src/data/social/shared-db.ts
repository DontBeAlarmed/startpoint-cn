import sqlite3, { type Database } from "better-sqlite3"
import { ensureAttentionSchema, ensurePresenceSchema } from "./attention-schema"

/**
 * 共享社交库：多节点/多进程部署时社交状态（铃铛招募、投递、presence）的
 * 平等读写落点——设置 env MULTI_SOCIAL_DB_PATH 指向共享 SQLite 文件即可，
 * 各进程独立打开连接（WAL + busy_timeout），无主客机身份。
 *
 * 单机单进程部署不设置该 env：attention 走主库（getDb()），presence 走内存
 * Map，行为与 A1 完全一致。
 *
 * 连接纪律借自参考服 sqlite-write-coordinator 的先行经验：WAL（读写并发）+
 * busy_timeout=1000ms（跨进程写竞争排队）+ 幂等 DDL。社交表无外键，
 * foreign_keys 保持 OFF。PG 属目标后端/部署侧决策，不在本仓接线。
 */

export function openSharedSocialDb(path: string): Database {
    const database = new sqlite3(path)
    database.pragma("journal_mode = WAL")
    database.pragma("busy_timeout = 1000")
    database.pragma("foreign_keys = OFF")
    ensureAttentionSchema(database)
    ensurePresenceSchema(database)
    return database
}

let sharedDb: Database | null | undefined

/** MULTI_SOCIAL_DB_PATH 单例连接；未设置时返回 null（调用方退回主库/内存实现） */
export function getSharedSocialDb(): Database | null {
    if (sharedDb === undefined) {
        const path = process.env.MULTI_SOCIAL_DB_PATH
        sharedDb = typeof path === "string" && path.trim() !== ""
            ? openSharedSocialDb(path.trim())
            : null
    }
    return sharedDb
}

/** 仅供测试复位单例 */
export function resetSharedSocialDbForTest(): void {
    if (sharedDb !== undefined && sharedDb !== null) sharedDb.close()
    sharedDb = undefined
}
