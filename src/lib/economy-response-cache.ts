// R-03 经济写路径请求级幂等：客户端每个请求自带会话内递增的 api_count
// （RequestQueue 全局计数器，mode 2 默认全开），同一逻辑请求的重试携带
// 相同计数。服务端按 (playerId, api_count) 记录响应，精确命中即原样回放
// （不再执行业务逻辑），未命中照常执行。
//
// 设计约束：
// - 键用会话解析后的 playerId，不用客户端上报的 viewer_id（防伪造回放他人响应）
// - 回放透传缓存字节（setCnMsgpackPendingEncoder），并校验端点一致——
//   错误回放比重复执行更危险，判定全程保守
// - TTL 10 分钟覆盖客户端重试窗口；LRU 有界；进程重启丢缓存 = 仅重启
//   瞬间的网络重试失去保护（fail-safe 退化为现状）

const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 4000

// 登录世代：客户端 api_count 是会话内计数，回标题即归零
//（TitleScene → Top.resetLogicAll → RequestQueue.reset → accessCount=0），
// 重登后的同计数请求与旧会话必然同 (playerId, api_count)——若键不含世代，
// TTL 窗口内的重登会把新会话请求误回放成旧响应（静默跳过业务执行）。
// signup（每次进游戏必发）时 bump，精确对齐客户端语义：跨会话不回放、
// 会话内重试照常回放。
const playerGenerations = new Map<number, number>()

interface CacheEntry {
    readonly endpoint: string
    payload: string
    expiresAt: number
    touchedAt: number
}

const entries = new Map<string, CacheEntry>()

function sweep(now: number): void {
    for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key)
    }
    while (entries.size > MAX_ENTRIES) {
        // LRU：淘汰最久未触达的条目
        let oldestKey: string | null = null
        let oldestTouched = Number.POSITIVE_INFINITY
        for (const [key, entry] of entries) {
            if (entry.touchedAt < oldestTouched) {
                oldestTouched = entry.touchedAt
                oldestKey = key
            }
        }
        if (oldestKey === null) break
        entries.delete(oldestKey)
    }
    // R-F01：世代键与条目缓存同治理——回收无任何条目引用的世代，防重复
    // 登录玩家长期累积。安全性：回收仅在玩家无存活条目时发生，故同号世代
    // 复用不可能与旧会话存活条目碰撞（误清在用世代仅表现为缓存失配多执行
    // 业务，无错误回放）。
    if (playerGenerations.size === 0) return
    const livePlayers = new Set<number>()
    for (const key of entries.keys()) {
        const separator = key.indexOf(":")
        if (separator <= 0) continue
        const playerId = Number(key.slice(0, separator))
        if (Number.isSafeInteger(playerId)) livePlayers.add(playerId)
    }
    for (const playerId of playerGenerations.keys()) {
        if (!livePlayers.has(playerId)) playerGenerations.delete(playerId)
    }
}

function cacheKey(playerId: number, apiCount: number): string {
    return `${playerId}:${playerGenerations.get(playerId) ?? 0}:${apiCount}`
}

/** signup 成功时推进登录世代：旧世代的缓存条目全部失配（等 TTL 清扫）。 */
export function bumpEconomyGenerationForPlayer(playerId: number): void {
    playerGenerations.set(playerId, (playerGenerations.get(playerId) ?? 0) + 1)
}

/** 查找回放。endpoint 不一致视为未命中（防跨端点误回放）。 */
export function findEconomyReplay(
    playerId: number,
    apiCount: number,
    endpoint: string,
): { payload: string } | null {
    const now = Date.now()
    const entry = entries.get(cacheKey(playerId, apiCount))
    if (entry === undefined) return null
    if (entry.expiresAt <= now || entry.endpoint !== endpoint) {
        entries.delete(cacheKey(playerId, apiCount))
        return null
    }
    entry.touchedAt = now
    return { payload: entry.payload }
}

/** 记录已成功执行（200）的响应字节，供同 (playerId, api_count) 重放。 */
export function rememberEconomyResponse(
    playerId: number,
    apiCount: number,
    endpoint: string,
    payload: string,
): void {
    const now = Date.now()
    const key = cacheKey(playerId, apiCount)
    const existing = entries.get(key)
    if (existing !== undefined) {
        existing.payload = payload
        existing.expiresAt = now + TTL_MS
        existing.touchedAt = now
        sweep(now)
        return
    }
    entries.set(key, {
        endpoint,
        payload,
        expiresAt: now + TTL_MS,
        touchedAt: now,
    })
    // R-F01：插入后清扫——若在插入前回收，刚 bump 的世代尚无条目会被立即
    // 回收，条目落到 gen 0，世代值在 0/1 间无谓抖动
    sweep(now)
}

/** 测试注入：清空缓存。 */
export function resetEconomyResponseCacheForTest(): void {
    entries.clear()
    playerGenerations.clear()
}

/** 测试观测：当前条目数。 */
export function economyResponseCacheSizeForTest(): number {
    return entries.size
}

/** 测试观测：世代键集合（R-F01 回收断言用）。 */
export function economyGenerationSizeForTest(): Set<number> {
    return new Set(playerGenerations.keys())
}
