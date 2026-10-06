import { getDb } from "../db"

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

/**
 * share_room 幂等落点：同一 (房主, 房间) 恒定一个 attention_key。
 * 客户端重发（每 15s）只刷新过期时间与快照，不产生新行/新 key。
 */
export function getOrCreateRecruitmentForRoom(input: {
    hostPid: number
    hostViewerId: number
    category: number
    questId: number
    roomNumber: string
    isNewbieHost: boolean
    establisherJson: string
    nowMs: number
}): { id: number; attentionKey: string; created: boolean } {
    const db = getDb()
    const existing = db.prepare(`
        SELECT id, attention_key FROM attention_recruitments
        WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
    `).get(input.hostViewerId, input.roomNumber) as { id: number; attention_key: string } | undefined
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
    const key = generateAttentionKey(input.hostViewerId)
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
}

/**
 * 读时惰性投递：guest 轮询 check 时才写入投递行（对齐官方
 * "房主 15s 重发 × guest 轮询"节奏，晚上线玩家下次轮询自然收到）。
 * 返回该玩家当前应见到的铃铛（新投递 + 已投递未响应），并保证投递行存在。
 * 已 accepted/declined 的不再出现；房主自己的招募对自己不可见。
 */
export function deliverOpenRecruitmentsToViewer(
    viewerId: number,
    nowMs: number,
    limit: number,
): AttentionRecruitment[] {
    const db = getDb()
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
}

/** quest/start（multi）携带 attention_key 时的招募解析；过期/关闭返回 null */
export function findOpenRecruitmentByKey(attentionKey: string, nowMs: number): AttentionRecruitment | null {
    const row = getDb().prepare(`
        SELECT * FROM attention_recruitments
        WHERE attention_key = ? AND status = 'open' AND expires_at_ms > ?
    `).get(attentionKey, nowMs) as Record<string, unknown> | undefined
    return row !== undefined ? mapRecruitmentRow(row) : null
}

/** 仅 delivered → accepted/declined 单向转移（幂等，不降级已响应状态） */
export function recordResponse(
    recruitmentId: number,
    viewerId: number,
    state: "accepted" | "declined",
    nowMs: number,
): void {
    getDb().prepare(`
        UPDATE attention_deliveries SET state = ?, acted_at_ms = ?
        WHERE recruitment_id = ? AND viewer_id = ? AND state = 'delivered'
    `).run(state, nowMs, recruitmentId, viewerId)
}

/** 解散房间时关闭该房间仍 open 的招募（开战/满员依赖过期收敛，不在此处理） */
export function closeRecruitmentForRoom(hostViewerId: number, roomNumber: string): void {
    getDb().prepare(`
        UPDATE attention_recruitments SET status = 'closed'
        WHERE host_viewer_id = ? AND room_number = ? AND status = 'open'
    `).run(hostViewerId, roomNumber)
}

/** 卫生兜底：把过期招募标记为 expired（读路径本就按 expires_at_ms 过滤，可选调用） */
export function expireStaleRecruitments(nowMs: number): void {
    getDb().prepare(`
        UPDATE attention_recruitments SET status = 'expired'
        WHERE status = 'open' AND expires_at_ms <= ?
    `).run(nowMs)
}

function mapRecruitmentRow(row: Record<string, unknown>): AttentionRecruitment {
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
        status: "open",
    }
}
