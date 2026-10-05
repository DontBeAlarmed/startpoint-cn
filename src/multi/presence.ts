/**
 * 节点内在线状态（内存 Map，零持久化）。
 * HTTP onResponse + TCP 帧上报；30s 节流（对齐参考服 online-presence）。
 * 跨节点好友在线查询由共享层负责（阶段 II/III）。
 */
const presenceMap = new Map<number, number>()
const THROTTLE_MS = 30_000

export function touchPresence(playerId: number, nowMs: number = Date.now()): void {
    const last = presenceMap.get(playerId)
    if (last !== undefined && nowMs - last < THROTTLE_MS) return
    presenceMap.set(playerId, nowMs)
}

export function isPresenceOnline(playerId: number, nowMs: number = Date.now()): boolean {
    const last = presenceMap.get(playerId)
    return last !== undefined && nowMs - last < THROTTLE_MS
}

export function onlinePlayerIds(nowMs: number = Date.now()): number[] {
    const result: number[] = []
    for (const [pid, last] of presenceMap) {
        if (nowMs - last < THROTTLE_MS) result.push(pid)
    }
    return result
}
