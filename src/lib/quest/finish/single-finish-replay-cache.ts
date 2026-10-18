// R-26：单人 finish 响应幂等缓存。已成功结算的 (playerId, playId) 在 TTL 内
// 重复 finish → 回放缓存的同一响应（而非 400），补全与 multi 侧
// finish-response-cache 同款的幂等闭环。缓存未命中（超时/重启）保持现状。
const DEFAULT_TTL_MS = 120_000
const DEFAULT_MAX_ENTRIES = 512

interface CacheEntry {
    readonly key: string
    readonly response: unknown
    readonly expiresAtMs: number
}

const cacheByKey = new Map<string, CacheEntry>()

function cacheKey(playerId: number, playId: string): string | null {
    if (typeof playId !== "string" || playId.length === 0) return null
    return `single:${playerId}:${playId}`
}

function sweep(nowMs: number): void {
    for (const [key, entry] of cacheByKey) {
        if (entry.expiresAtMs <= nowMs) cacheByKey.delete(key)
    }
    while (cacheByKey.size > DEFAULT_MAX_ENTRIES) {
        const oldest = cacheByKey.keys().next().value
        if (oldest === undefined) break
        cacheByKey.delete(oldest)
    }
}

export function rememberSingleFinishResponse(
    playerId: number,
    playId: string,
    response: unknown,
    nowMs: number = Date.now(),
): void {
    const key = cacheKey(playerId, playId)
    if (key === null) return
    sweep(nowMs)
    cacheByKey.set(key, {
        key,
        response,
        expiresAtMs: nowMs + DEFAULT_TTL_MS,
    })
}

/** 命中返回缓存的响应对象；未命中（超时/重启/非法 playId）返回 null。 */
export function getSettledSingleFinishResponse(
    playerId: number,
    playId: string,
    nowMs: number = Date.now(),
): unknown | null {
    const key = cacheKey(playerId, playId)
    if (key === null) return null
    const entry = cacheByKey.get(key)
    if (entry === undefined) return null
    if (entry.expiresAtMs <= nowMs) {
        cacheByKey.delete(key)
        return null
    }
    return entry.response
}

/** 测试注入：清空缓存。 */
export function resetSingleFinishReplayCacheForTest(): void {
    cacheByKey.clear()
}
