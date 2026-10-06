import type { Database } from "better-sqlite3"
import { getDb } from "../db"
import { getSharedSocialDb } from "../social/shared-db"

export interface AttentionRecruitment {
    id: number
    attentionKey: string
    roomNumber: string
    hostPid: number
    hostViewerId: number
    category: number
    questId: number
    isNewbieHost: boolean
    establisherJson: string
    postedAtMs: number
    expiresAtMs: number
    status: "open" | "closed" | "expired"
}

/** 铃铛展示用的房主快照（share_room 时捕获，check 时原样下发） */
export interface EstablisherSnapshot {
    character: number
    rankLevel: number
    hostEntryTime: number
}

// 房主客户端每 15s（attention_recruitment_interval_seconds）重发一次 share_room
// （上限 redeliver_limit=20 次）。单次授权 45s ≈ 3 个重发间隔：房主停止重发
// （满员/开战/解散/掉线）后，铃铛最迟 45s 内从 guest 轮询中消失。
const DEFAULT_RECRUITMENT_LIFETIME_MS = 45_000

// 过期行保留 24h（已 accepted/declined 的投递历史随行删除；重开的新招募是全新行）
const PRUNE_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * 社交域存储接口（A2）：多节点部署时社交状态的平等读写边界。
 * 默认实现为主库 SQLite；设置 MULTI_SOCIAL_DB_PATH 后由共享社交库承载
 * （见 src/data/social/shared-db.ts）。PG 后端属部署侧决策，接口即接入形态。
 */
export interface AttentionStore {
    getOrCreateRecruitmentForRoom(input: {
        hostPid: number
        hostViewerId: number
        category: number
        questId: number
        roomNumber: string
        isNewbieHost: boolean
        establisherJson: string
        nowMs: number
    }): { id: number; attentionKey: string; created: boolean }
    deliverOpenRecruitmentsToViewer(
        viewerId: number,
        nowMs: number,
        limit: number,
    ): AttentionRecruitment[]
    findOpenRecruitmentByKey(attentionKey: string, nowMs: number): AttentionRecruitment | null
    /** summon 释放判定用：按 (房主, 房间) 读 open 招募；过期/关闭返回 null；
     * includeExpired=true 时不过滤过期（释放点服务端接管行寿命的兜底读） */
    findOpenRecruitmentForRoom(hostViewerId: number, roomNumber: string, nowMs: number, includeExpired?: boolean): AttentionRecruitment | null
    /** T2 门票：投递行存在且未被拒绝（delivered/accepted 均持票） */
    hasActiveDelivery(recruitmentId: number, viewerId: number): boolean
    recordResponse(
        recruitmentId: number,
        viewerId: number,
        state: "accepted" | "declined",
        nowMs: number,
    ): void
    closeRecruitmentForRoom(hostViewerId: number, roomNumber: string): void
    /** keep-open 行寿命接管：NPC 进场后把 open 招募过期时间外推（服务端接管，客户端停铃不再依赖） */
    refreshRecruitmentForRoom(hostViewerId: number, roomNumber: string, nowMs: number, lifetimeMs: number): void
    /** 热切换清扫：publishBell on→off 时全量关闭 open 招募（共享库下跨节点生效） */
    closeAllOpenRecruitments(): void
    expireStaleRecruitments(nowMs: number): void
    pruneExpiredRecruitments(nowMs: number, retentionMs?: number): void
}

export function getRecruitmentLifetimeMs(): number {
    const raw = Number(process.env.MULTI_ATTENTION_RECRUITMENT_LIFETIME_MS)
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECRUITMENT_LIFETIME_MS
}

export function buildEstablisherSnapshot(input: EstablisherSnapshot): string {
    return JSON.stringify(input)
}

export function parseEstablisherSnapshot(json: string | null | undefined): EstablisherSnapshot {
    // 展示字段缺失不阻断投递：旧行/异常行 fail-open 为 0 值
    try {
        const raw = JSON.parse(json ?? "{}") as Partial<Record<keyof EstablisherSnapshot, unknown>>
        return {
            character: Number(raw.character) || 0,
            rankLevel: Number(raw.rankLevel) || 0,
            hostEntryTime: Number(raw.hostEntryTime) || 0,
        }
    } catch {
        return { character: 0, rankLevel: 0, hostEntryTime: 0 }
    }
}

function generateAttentionKey(hostViewerId: number): string {
    const rand = Math.floor(100000 + Math.random() * 900000)
    return `attention_${rand}_${hostViewerId}`
}

function isUniqueConstraintError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    return code === "SQLITE_CONSTRAINT_UNIQUE"
        || String((error as Error | null)?.message ?? "").includes("UNIQUE")
}

/**
 * SQLite 实现：主库与共享社交库共用（连接由构造方决定）。
 * 读时惰性投递对多节点天然友好——任何进程轮询 check 都从同一存储收敛。
 */
export function createSqliteAttentionStore(db: Database): AttentionStore {
    return {
        /**
         * share_room 幂等落点：同一 (房主, 房间) 恒定一个 attention_key。
         * 客户端重发（每 15s）只刷新过期时间与快照，不产生新行/新 key。
         * 事务包裹 + attention_key UNIQUE 碰撞换随机数重试，避免历史残留 key 让分享 500。
         */
        getOrCreateRecruitmentForRoom(input) {
            // BEGIN IMMEDIATE：开事务即取写锁（busy_timeout 正常排队），
            // 避免 deferred 事务在共享库多进程下 SELECT→写升级撞 SQLITE_BUSY_SNAPSHOT
            //（该错误不吃 busy_timeout；对齐参考服 BEGIN IMMEDIATE 纪律）
            const immediate = db.transaction((): { id: number; attentionKey: string; created: boolean } => {
                // expires_at 过滤：过期行不得被重发"复活"（复活会保旧 posted_at，
                // 窗口起点错乱）；过期重发 = 全新行/新 key/新 posted_at（收官审查 B2/C3）
                const existing = db.prepare(`
                    SELECT id, attention_key FROM attention_recruitments
                    WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
                        AND expires_at_ms > ?
                `).get(input.hostViewerId, input.roomNumber, input.nowMs) as { id: number; attention_key: string } | undefined
                if (existing !== undefined) {
                    db.prepare(`
                        UPDATE attention_recruitments
                        SET category = ?, quest_id = ?, is_newbie_host = ?, establisher_json = ?,
                            expires_at_ms = ?
                        WHERE id = ?
                    `).run(
                        input.category,
                        input.questId,
                        input.isNewbieHost ? 1 : 0,
                        input.establisherJson,
                        input.nowMs + getRecruitmentLifetimeMs(),
                        existing.id,
                    )
                    return { id: existing.id, attentionKey: existing.attention_key, created: false }
                }
                for (let attempt = 0; attempt < 3; attempt++) {
                    const key = generateAttentionKey(input.hostViewerId)
                    try {
                        const result = db.prepare(`
                            INSERT INTO attention_recruitments
                                (attention_key, room_number, host_pid, host_viewer_id,
                                 category, quest_id, is_newbie_host, establisher_json,
                                 posted_at_ms, expires_at_ms, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
                        `).run(
                            key, input.roomNumber, input.hostPid, input.hostViewerId,
                            input.category, input.questId,
                            input.isNewbieHost ? 1 : 0, input.establisherJson,
                            input.nowMs, input.nowMs + getRecruitmentLifetimeMs(),
                        )
                        return { id: Number(result.lastInsertRowid), attentionKey: key, created: true }
                    } catch (error) {
                        if (!isUniqueConstraintError(error) || attempt === 2) throw error
                    }
                }
                throw new Error("unreachable: attention_key generation exhausted retries")
            })
            return immediate.immediate()
        },

        /**
         * 读时惰性投递：guest 轮询 check 时才写入投递行（对齐官方
         * "房主 15s 重发 × guest 轮询"节奏，晚上线玩家下次轮询自然收到）。
         * 返回该玩家当前应见到的铃铛（新投递 + 已投递未响应），并保证投递行存在。
         * 已 accepted/declined 的不再出现；房主自己的招募对自己不可见。
         */
        deliverOpenRecruitmentsToViewer(viewerId, nowMs, limit) {
            const rows = db.prepare(`
                SELECT r.* FROM attention_recruitments r
                LEFT JOIN attention_deliveries d
                    ON d.recruitment_id = r.id AND d.viewer_id = ?
                WHERE r.status = 'open' AND r.expires_at_ms > ?
                    AND r.host_viewer_id != ?
                    AND (d.state IS NULL OR d.state = 'delivered')
                ORDER BY r.posted_at_ms DESC
                LIMIT ?
            `).all(viewerId, nowMs, viewerId, limit) as Array<Record<string, unknown>>
            const insertDelivery = db.prepare(`
                INSERT OR IGNORE INTO attention_deliveries (recruitment_id, viewer_id, state)
                VALUES (?, ?, 'delivered')
            `)
            for (const row of rows) insertDelivery.run(Number(row.id), viewerId)
            return rows.map(mapRecruitmentRow)
        },

        /** quest/start（multi）携带 attention_key 时的招募解析；过期/关闭返回 null */
        findOpenRecruitmentByKey(attentionKey, nowMs) {
            const row = db.prepare(`
                SELECT * FROM attention_recruitments
                WHERE attention_key = ? AND status = 'open' AND expires_at_ms > ?
            `).get(attentionKey, nowMs) as Record<string, unknown> | undefined
            return row !== undefined ? mapRecruitmentRow(row) : null
        },

        /** summon 释放判定用：按 (房主, 房间) 读 open 招募；过期/关闭返回 null；
         * includeExpired=true 时不过滤过期（释放点服务端接管行寿命的兜底读） */
        findOpenRecruitmentForRoom(hostViewerId, roomNumber, nowMs, includeExpired = false) {
            const expiryFilter = includeExpired ? "" : "AND expires_at_ms > ?"
            const params = includeExpired
                ? [hostViewerId, roomNumber]
                : [hostViewerId, roomNumber, nowMs]
            const row = db.prepare(`
                SELECT * FROM attention_recruitments
                WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
                    ${expiryFilter}
                ORDER BY posted_at_ms DESC
                LIMIT 1
            `).get(...params) as Record<string, unknown> | undefined
            return row !== undefined ? mapRecruitmentRow(row) : null
        },

        /** T2 门票：投递行存在且未被拒绝（delivered/accepted 均持票） */
        hasActiveDelivery(recruitmentId, viewerId) {
            const row = db.prepare(`
                SELECT state FROM attention_deliveries
                WHERE recruitment_id = ? AND viewer_id = ?
            `).get(recruitmentId, viewerId) as { state: string } | undefined
            return row !== undefined && row.state !== "declined"
        },

        /** 仅 delivered → accepted/declined 单向转移（幂等，不降级已响应状态） */
        recordResponse(recruitmentId, viewerId, state, nowMs) {
            db.prepare(`
                UPDATE attention_deliveries SET state = ?, acted_at_ms = ?
                WHERE recruitment_id = ? AND viewer_id = ? AND state = 'delivered'
            `).run(state, nowMs, recruitmentId, viewerId)
        },

        /** 解散房间时关闭该房间仍 open 的招募（开战/满员依赖过期收敛，不在此处理） */
        closeRecruitmentForRoom(hostViewerId, roomNumber) {
            db.prepare(`
                UPDATE attention_recruitments SET status = 'closed'
                WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
            `).run(hostViewerId, roomNumber)
        },

        /** keep-open 行寿命接管：仅 open 行生效；过期/关闭行不复活 */
        refreshRecruitmentForRoom(hostViewerId, roomNumber, nowMs, lifetimeMs) {
            db.prepare(`
                UPDATE attention_recruitments SET expires_at_ms = ?
                WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
                    AND expires_at_ms > ?
            `).run(nowMs + lifetimeMs, hostViewerId, roomNumber, nowMs)
        },

        /** 热切换清扫：publishBell on→off 时全量关闭 open 招募（共享库下跨节点生效） */
        closeAllOpenRecruitments() {
            db.prepare(`
                UPDATE attention_recruitments SET status = 'closed'
                WHERE status = 'open'
            `).run()
        },

        /** 卫生兜底：把过期招募标记为 expired（读路径本就按 expires_at_ms 过滤，可选调用） */
        expireStaleRecruitments(nowMs) {
            db.prepare(`
                UPDATE attention_recruitments SET status = 'expired'
                WHERE status = 'open' AND expires_at_ms <= ?
            `).run(nowMs)
        },

        /**
         * 长期清理：过期 open 行标记 expired，且把过期超过保留期的行连同投递历史删除
         * （否则 attention_recruitments/attention_deliveries 只增不减，且 6 位随机
         * attention_key 的碰撞概率随历史行数单调上升）。挂在房主重发节奏上调用。
         */
        pruneExpiredRecruitments(nowMs, retentionMs = PRUNE_RETENTION_MS) {
            const immediate = db.transaction(() => {
                db.prepare(`
                    UPDATE attention_recruitments SET status = 'expired'
                    WHERE status = 'open' AND expires_at_ms <= ?
                `).run(nowMs)
                const cutoff = nowMs - retentionMs
                db.prepare(`
                    DELETE FROM attention_deliveries WHERE recruitment_id IN (
                        SELECT id FROM attention_recruitments
                        WHERE expires_at_ms < ? AND status != 'open'
                    )
                `).run(cutoff)
                db.prepare(`
                    DELETE FROM attention_recruitments
                    WHERE expires_at_ms < ? AND status != 'open'
                `).run(cutoff)
            })
            immediate.immediate()
        },
    }
}

let configuredAttentionStore: AttentionStore | null = null

/**
 * 进程级单例：设置 MULTI_SOCIAL_DB_PATH → 共享社交库；否则主库。
 * 兼容层函数（下方导出）都走这里，调用点无需感知部署形态。
 * 注意：主库连接按"每进程只初始化一次"的仓库假设在首次调用时钉住
 * （生产 closeDatabase 仅发生在关机；若将来出现进程内 close+重建，需同步复位本单例）。
 */
export function getAttentionStore(): AttentionStore {
    if (configuredAttentionStore === null) {
        const shared = getSharedSocialDb()
        configuredAttentionStore = createSqliteAttentionStore(shared ?? getDb())
    }
    return configuredAttentionStore
}

// ---- 兼容层：保持 A1 的模块级函数导出（调用点与既有测试零改动） ----

export function getOrCreateRecruitmentForRoom(input: Parameters<AttentionStore["getOrCreateRecruitmentForRoom"]>[0]) {
    return getAttentionStore().getOrCreateRecruitmentForRoom(input)
}

export function deliverOpenRecruitmentsToViewer(viewerId: number, nowMs: number, limit: number) {
    return getAttentionStore().deliverOpenRecruitmentsToViewer(viewerId, nowMs, limit)
}

export function findOpenRecruitmentByKey(attentionKey: string, nowMs: number) {
    return getAttentionStore().findOpenRecruitmentByKey(attentionKey, nowMs)
}

export function findOpenRecruitmentForRoom(
    hostViewerId: number,
    roomNumber: string,
    nowMs: number,
    includeExpired = false,
) {
    return getAttentionStore().findOpenRecruitmentForRoom(hostViewerId, roomNumber, nowMs, includeExpired)
}

export function hasActiveDelivery(recruitmentId: number, viewerId: number): boolean {
    return getAttentionStore().hasActiveDelivery(recruitmentId, viewerId)
}

export function closeAllOpenRecruitments(): void {
    getAttentionStore().closeAllOpenRecruitments()
}

export function refreshRecruitmentForRoom(
    hostViewerId: number,
    roomNumber: string,
    nowMs: number,
    lifetimeMs: number,
): void {
    getAttentionStore().refreshRecruitmentForRoom(hostViewerId, roomNumber, nowMs, lifetimeMs)
}

export function recordResponse(
    recruitmentId: number,
    viewerId: number,
    state: "accepted" | "declined",
    nowMs: number,
): void {
    getAttentionStore().recordResponse(recruitmentId, viewerId, state, nowMs)
}

export function closeRecruitmentForRoom(hostViewerId: number, roomNumber: string): void {
    getAttentionStore().closeRecruitmentForRoom(hostViewerId, roomNumber)
}

export function expireStaleRecruitments(nowMs: number): void {
    getAttentionStore().expireStaleRecruitments(nowMs)
}

export function pruneExpiredRecruitments(nowMs: number, retentionMs?: number): void {
    getAttentionStore().pruneExpiredRecruitments(nowMs, retentionMs)
}

function mapRecruitmentRow(row: Record<string, unknown>): AttentionRecruitment {
    const status = row.status
    return {
        id: Number(row.id),
        attentionKey: String(row.attention_key),
        roomNumber: String(row.room_number),
        hostPid: Number(row.host_pid),
        hostViewerId: Number(row.host_viewer_id),
        category: Number(row.category),
        questId: Number(row.quest_id),
        isNewbieHost: Number(row.is_newbie_host) === 1,
        establisherJson: String(row.establisher_json ?? "{}"),
        postedAtMs: Number(row.posted_at_ms),
        expiresAtMs: Number(row.expires_at_ms),
        status: status === "closed" || status === "expired" ? status : "open",
    }
}
