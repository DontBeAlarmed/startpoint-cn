/**
 * 节点内在线状态（内存 Map，零持久化），键空间为 viewer_id
 * （铃铛投递/检查全链路都以 viewer_id 为协议主键）。
 * A1 来源：/attention/check 轮询 touch（原版客户端不加新请求）。
 *
 * presence 度量"进程存活"，属真实时钟域：默认经 getRealNowMs() 取时。
 * 禁止传入虚拟钟（getServerTime 域，默认偏移约 2 年）——混用会得到
 * 永久在线/永久离线的错判。
 * 上报节流 30s 与在线判定窗口 5min 是两个独立常量（对齐参考服
 * online-presence 的双常量语义，非"窗口=节流"）。
 * 跨节点好友在线查询由共享层负责（阶段 II/III）。
 */
import { getRealNowMs } from "../runtime/time/game-time"

const presenceMap = new Map<number, number>()

export const PRESENCE_THROTTLE_MS = 30_000
export const PRESENCE_WINDOW_MS = 5 * 60_000

// 免疫长期缓涨：历史条目超过阈值时，touch 顺带清扫早已过期的 viewer
const PRESENCE_SWEEP_THRESHOLD = 1024

export function touchPresence(viewerId: number, nowMs: number = getRealNowMs()): void {
    const last = presenceMap.get(viewerId)
    if (last !== undefined && nowMs - last < PRESENCE_THROTTLE_MS) return
    presenceMap.set(viewerId, nowMs)
    if (presenceMap.size > PRESENCE_SWEEP_THRESHOLD) {
        for (const [staleViewerId, seen] of presenceMap) {
            if (nowMs - seen >= PRESENCE_WINDOW_MS) presenceMap.delete(staleViewerId)
        }
    }
}

export function isPresenceOnline(viewerId: number, nowMs: number = getRealNowMs()): boolean {
    const last = presenceMap.get(viewerId)
    return last !== undefined && nowMs - last < PRESENCE_WINDOW_MS
}

export function onlineViewerIds(nowMs: number = getRealNowMs()): number[] {
    const result: number[] = []
    for (const [viewerId, last] of presenceMap) {
        if (nowMs - last < PRESENCE_WINDOW_MS) result.push(viewerId)
    }
    return result
}
