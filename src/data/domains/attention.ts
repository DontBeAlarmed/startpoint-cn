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
    status: "open" | "closed"
}

export interface AttentionDelivery {
    recruitmentId: number
    viewerId: number
    state: "delivered" | "accepted" | "declined"
    actedAtMs: number | null
}

export function createRecruitment(input: {
    roomNumber: string
    hostPid: number
    hostViewerId: number
    category: number
    questId: number
    isNewbieHost: boolean
    establisherJson: string
    nowMs: number
    lifetimeMs: number
}): { id: number; attentionKey: string } {
    const key = `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const result = getDb().prepare(`
        INSERT INTO attention_recruitments
            (attention_key, room_number, host_pid, host_viewer_id,
             category, quest_id, is_newbie_host, establisher_json,
             posted_at_ms, expires_at_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(
        key, input.roomNumber, input.hostPid, input.hostViewerId,
        input.category, input.questId,
        input.isNewbieHost ? 1 : 0, input.establisherJson,
        input.nowMs, input.nowMs + input.lifetimeMs,
    )
    return { id: Number(result.lastInsertRowid), attentionKey: key }
}

/** 该玩家被投递且未响应的招募（data.multi[] 数据源） */
export function listPendingDeliveriesFor(viewerId: number, nowMs: number): Array<{
    recruitment: AttentionRecruitment
    delivery: AttentionDelivery
}> {
    const rows = getDb().prepare(`
        SELECT r.*, d.state AS delivery_state, d.acted_at_ms AS delivery_acted_at
        FROM attention_deliveries d
        JOIN attention_recruitments r ON r.id = d.recruitment_id
        WHERE d.viewer_id = ? AND d.state = 'delivered'
            AND r.status = 'open' AND r.expires_at_ms > ?
    `).all(viewerId, nowMs) as Array<Record<string, unknown>>
    return rows.map(row => ({
        recruitment: {
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
            status: "open" as const,
        },
        delivery: {
            recruitmentId: Number(row.id),
            viewerId,
            state: "delivered" as const,
            actedAtMs: null,
        },
    }))
}

export function recordDelivery(recruitmentId: number, viewerId: number): void {
    getDb().prepare(`
        INSERT OR IGNORE INTO attention_deliveries (recruitment_id, viewer_id, state)
        VALUES (?, ?, 'delivered')
    `).run(recruitmentId, viewerId)
}

export function recordResponse(recruitmentId: number, viewerId: number, state: "accepted" | "declined"): void {
    getDb().prepare(`
        UPDATE attention_deliveries SET state = ?, acted_at_ms = ?
        WHERE recruitment_id = ? AND viewer_id = ?
    `).run(state, Date.now(), recruitmentId, viewerId)
}

export function expireStaleRecruitments(nowMs: number): void {
    getDb().prepare(`
        UPDATE attention_recruitments SET status = 'expired'
        WHERE status = 'open' AND expires_at_ms <= ?
    `).run(nowMs)
}
