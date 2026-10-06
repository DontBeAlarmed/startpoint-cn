/**
 * 节点内在线状态（内存 Map，零持久化），键空间为 viewer_id
 * （铃铛投递/检查全链路都以 viewer_id 为协议主键）。
 * A1 来源：/attention/check 轮询 touch（原版客户端不加新请求）。
 * 30s 节流（对齐参考服 online-presence）。跨节点好友在线查询由共享层负责（阶段 II/III）。
 */
const presenceMap = new Map<number, number>()
const THROTTLE_MS = 30_000

export function touchPresence(viewerId: number, nowMs: number = Date.now()): void {
    const last = presenceMap.get(viewerId)
    if (last !== undefined && nowMs - last < THROTTLE_MS) return
    presenceMap.set(viewerId, nowMs)
}

export function isPresenceOnline(viewerId: number, nowMs: number = Date.now()): boolean {
    const last = presenceMap.get(viewerId)
    return last !== undefined && nowMs - last < THROTTLE_MS
}

export function onlineViewerIds(nowMs: number = Date.now()): number[] {
    const result: number[] = []
    for (const [viewerId, last] of presenceMap) {
        if (nowMs - last < THROTTLE_MS) result.push(viewerId)
    }
    return result
}
