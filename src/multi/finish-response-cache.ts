
/**
 * 多人 finish 响应幂等缓存（对齐参考服 finish-response-cache）：
 * key = multi:viewerId:category:questId:playId；无 play_id 的请求不缓存
 * （防止把两次合法连刷误判为重试）。TTL 内重复 finish 回放同一响应。
 */
const DEFAULT_TTL_MS = 120_000
const DEFAULT_MAX_ENTRIES = 512

interface CacheEntry {
    readonly key: string
    readonly response: unknown
    readonly expiresAtMs: number
}

const cacheByKey = new Map<string, CacheEntry>()

function cacheKey(viewerId: number, category: number, questId: number, playId: string | null | undefined): string | null {
    if (typeof playId !== "string" || playId.length === 0) return null
    return `multi:${viewerId}:${category}:${questId}:${playId}`
}

export function getCachedFinishResponse(
    viewerId: number,
    category: number,
    questId: number,
    playId: string | null | undefined,
): unknown | null {
    const key = cacheKey(viewerId, category, questId, playId)
    if (key === null) return null
    const entry = cacheByKey.get(key)
    if (entry === undefined) return null
    // R-15=B：缓存 TTL 锚真实时间（基础设施瞬态，与内容时间轴无关）
    if (Date.now() > entry.expiresAtMs) {
        cacheByKey.delete(key)
        return null
    }
    // LRU 语义：命中刷新插入序
    cacheByKey.delete(key)
    cacheByKey.set(key, entry)
    return entry.response
}

export function cacheFinishResponse(
    viewerId: number,
    category: number,
    questId: number,
    playId: string | null | undefined,
    response: unknown,
): void {
    const key = cacheKey(viewerId, category, questId, playId)
    if (key === null) return
    // 插入时顺带清扫链头连续过期条目：低流量下过期条目不必等 LRU 逐出才释放
    const nowMs = Date.now()
    for (const [oldestKey, oldest] of cacheByKey) {
        if (nowMs <= oldest.expiresAtMs) break
        cacheByKey.delete(oldestKey)
    }
    if (cacheByKey.size >= DEFAULT_MAX_ENTRIES) {
        const oldest = cacheByKey.keys().next().value
        if (oldest !== undefined) cacheByKey.delete(oldest)
    }
    cacheByKey.set(key, {
        key,
        response,
        expiresAtMs: nowMs + DEFAULT_TTL_MS,
    })
}

/** 测试隔离钩子：清空全部缓存条目（生产代码不得调用）。 */
export function clearFinishResponseCacheForTest(): void {
    cacheByKey.clear()
}
