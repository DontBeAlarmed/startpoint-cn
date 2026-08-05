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
    state: "pending" | "settled"
    expiresAt: number
    readonly result: Promise<CachedJsonResponse>
}

export class IdempotencyCapacityError extends Error {
    readonly code = "IDEMPOTENCY_CAPACITY_EXCEEDED"

    constructor() {
        super("idempotency cache capacity exceeded")
        this.name = "IdempotencyCapacityError"
    }
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
        if (this.entries.size >= this.maxEntries && !this.evictOldestSettled()) {
            return Promise.reject(new IdempotencyCapacityError())
        }

        let entry!: CacheEntry
        const settle = (): void => {
            entry.state = "settled"
            entry.expiresAt = this.now() + this.ttlMs
        }
        const result = Promise.resolve().then(handler).then(
            value => {
                settle()
                return value
            },
            error => {
                settle()
                throw error
            },
        )
        entry = { state: "pending", expiresAt: Number.POSITIVE_INFINITY, result }
        this.entries.set(cacheKey, entry)
        return result
    }

    private cleanup(): void {
        const now = this.now()
        for (const [key, entry] of this.entries) {
            if (entry.state === "settled" && entry.expiresAt <= now) {
                this.entries.delete(key)
            }
        }
    }

    private evictOldestSettled(): boolean {
        for (const [key, entry] of this.entries) {
            if (entry.state !== "settled") continue
            this.entries.delete(key)
            return true
        }
        return false
    }
}
