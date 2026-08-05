export interface CachedJsonResponse {
    readonly statusCode: number
    readonly body: string
}

export interface IdempotencyCacheOptions {
    readonly now?: () => number
    readonly ttlMs?: number
    readonly maxEntries?: number
}

interface CacheEntry {
    readonly expiresAt: number
    readonly result: Promise<CachedJsonResponse>
}

export function isValidIdempotencyKey(value: unknown): value is string {
    return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value)
}

export class IdempotencyCache {
    private readonly entries = new Map<string, CacheEntry>()
    private readonly now: () => number
    private readonly ttlMs: number
    private readonly maxEntries: number

    constructor(options: IdempotencyCacheOptions = {}) {
        this.now = options.now ?? Date.now
        this.ttlMs = options.ttlMs ?? 30_000
        this.maxEntries = options.maxEntries ?? 1_024
        if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0
            || !Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
            throw new TypeError("invalid idempotency cache options")
        }
    }

    execute(
        nodeSessionId: string,
        operation: string,
        key: string,
        handler: () => Promise<CachedJsonResponse>,
    ): Promise<CachedJsonResponse> {
        this.cleanup()
        const cacheKey = `${nodeSessionId}\0${operation}\0${key}`
        const existing = this.entries.get(cacheKey)
        if (existing) return existing.result

        const result = Promise.resolve().then(handler).catch(error => {
            this.entries.delete(cacheKey)
            throw error
        })
        this.entries.set(cacheKey, { expiresAt: this.now() + this.ttlMs, result })
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value as string | undefined
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
        return result
    }

    private cleanup(): void {
        const now = this.now()
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key)
        }
    }
}
