// 解散影子表（5805 根治 · 2026-10-30 设计定案）：
// 房主解散时若有"TCP 已握手、Enter 未到"的在途入房者，房间从主册摘除
// （对外立即呈现"已解散"——新加入者/列表查询拿 ROOM_NOT_FOUND），房间对象
// 转入影子表，仅对已在途者可见：其 Enter 到达后在影子内完成入房并立即
// dismiss+关闭（客户端拆除流程完整走完，cooperationRoomStatus 生命期安全）。
// 在途集合空 → 影子销毁。事件驱动，无生死猜测定时器；GC 上限仅作半开
// 连接的资源回收边界（影子对外完全不可见，无行为影响）。

import type { MultiRoom } from "../types"

interface RoomDisbandShadow {
    readonly room: MultiRoom
    /** 已握手未 Enter 的在途 socket 标识集合 */
    readonly pending: Set<string>
    gcTimer: ReturnType<typeof setTimeout> | null
}

const shadows = new Map<string, RoomDisbandShadow>()

/** 半开连接兜底：影子最长存留（期间对外不可见，仅资源边界）。 */
const SHADOW_GC_MS = 5 * 60_000

export function hasInFlightJoiners(roomNumber: string): boolean {
    return shadows.has(roomNumber)
}

export function registerInFlightJoin(roomNumber: string, socketKey: string): void {
    const shadow = shadows.get(roomNumber)
    if (!shadow) return
    shadow.pending.add(socketKey)
}

export function resolveInFlightJoin(roomNumber: string, socketKey: string): MultiRoom | undefined {
    const shadow = shadows.get(roomNumber)
    if (!shadow) return undefined
    shadow.pending.delete(socketKey)
    maybeDestroyShadow(roomNumber)
    return shadow.room
}

export function abandonInFlightJoin(roomNumber: string, socketKey: string): void {
    const shadow = shadows.get(roomNumber)
    if (!shadow) return
    shadow.pending.delete(socketKey)
    maybeDestroyShadow(roomNumber)
}

/**
 * 主册解散时调用：有在途者 → 房间进影子表（返回 true，删除挂起）；
 * 无在途者 → 返回 false（调用方正常删除）。
 */
export function parkDisbandingRoom(room: MultiRoom, inFlightKeys: readonly string[]): boolean {
    if (inFlightKeys.length === 0) return false
    const gcTimer = setTimeout(() => {
        shadows.delete(room.room_number)
    }, SHADOW_GC_MS)
    gcTimer.unref?.()
    shadows.set(room.room_number, Object.freeze({
        room,
        pending: new Set(inFlightKeys),
        gcTimer,
    }))
    return true
}

function maybeDestroyShadow(roomNumber: string): void {
    const shadow = shadows.get(roomNumber)
    if (!shadow) return
    if (shadow.pending.size > 0) return
    if (shadow.gcTimer) clearTimeout(shadow.gcTimer)
    shadows.delete(roomNumber)
}

export function resetRoomDisbandShadows(): void {
    for (const shadow of shadows.values()) {
        if (shadow.gcTimer) clearTimeout(shadow.gcTimer)
    }
    shadows.clear()
}

/**
 * 握手点查询：该 viewer 是否是此影子房间的在途入房者。是 → 登记其 socket
 * 键（Enter 用同键解析）并返回影子房间；否 → undefined（握手照常拒绝）。
 */
export function resolveShadowRoomForViewer(
    roomNumber: string,
    viewerId: number,
    socket: import("net").Socket,
): MultiRoom | undefined {
    const shadow = shadows.get(roomNumber)
    if (!shadow) return undefined
    if (shadow.room.host_viewer_id === viewerId) return shadow.room
    if (!shadow.pending.has(`viewer:${viewerId}`)) return undefined
    registerInFlightJoin(roomNumber, `socket:${socket.remotePort}`)
    return shadow.room
}

/**
 * 死亡事件接线：SessionManager 在 socket 关闭时回调（解耦：避免循环 import）。
 * 影子集合按 viewer 键移除在途者，集合空时销毁影子。
 */
export function installInFlightJoinAbandonmentHook(
    sessionManager: { onInFlightJoinAbandoned: ((roomNumber: string, viewerKey: string) => void) | null },
): void {
    sessionManager.onInFlightJoinAbandoned = (roomNumber, viewerKey) => {
        const shadow = shadows.get(roomNumber)
        if (!shadow) return
        shadow.pending.delete(viewerKey)
        maybeDestroyShadow(roomNumber)
    }
}
