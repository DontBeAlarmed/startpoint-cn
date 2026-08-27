import type { Database } from "better-sqlite3"
import { clientSerializeDate } from "../data/utils/date"

export const DEFAULT_RECEIVE_HISTORY_MAX_AGE_DAYS = 31
export const DEFAULT_RECEIVE_HISTORY_MAX_ROWS = 500
export const DEFAULT_RECEIVE_HISTORY_BATCH_SIZE = 500

export interface ReceiveHistoryRetentionConfig {
    readonly enabled: boolean
    readonly maxAgeDays: number
    readonly maxRowsPerPlayer: number
}

export interface ReceiveHistoryRetentionBatchOptions {
    readonly maxAgeDays: number
    readonly maxRowsPerPlayer: number
    readonly batchSize?: number
}

export interface ReceiveHistoryRetentionBatchResult {
    readonly deletedExpired: number
    readonly deletedOverflow: number
    readonly deletedRows: number
    readonly hasMore: boolean
}

export interface ReceiveHistoryRetentionPassResult {
    readonly batches: number
    readonly deletedExpired: number
    readonly deletedOverflow: number
    readonly deletedRows: number
}

export interface ReceiveHistoryRetentionServiceOptions extends ReceiveHistoryRetentionConfig {
    readonly batchSize?: number
    readonly initialDelayMs?: number
    readonly intervalMs?: number
}

interface RetentionTimer {
    unref(): void
}

export interface ReceiveHistoryRetentionServiceDependencies {
    readonly getNow?: () => Date
    readonly createTimeout?: (
        callback: () => void | Promise<void>,
        delayMs: number,
    ) => RetentionTimer
    readonly clearTimeout?: (timer: RetentionTimer) => void
    readonly yieldBetweenBatches?: () => Promise<void>
    readonly logger?: Pick<Console, "log" | "warn">
}

const DEFAULT_INITIAL_DELAY_MS = 60_000
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function positiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || !/^\d+$/.test(value)) return fallback
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveReceiveHistoryRetentionConfig(
    environment: NodeJS.ProcessEnv = process.env,
): ReceiveHistoryRetentionConfig {
    const enabledValue = environment.RECEIVE_HISTORY_RETENTION_ENABLED?.trim().toLowerCase()
    return Object.freeze({
        enabled: enabledValue !== "0"
            && enabledValue !== "false"
            && enabledValue !== "off"
            && enabledValue !== "no",
        maxAgeDays: positiveInteger(
            environment.RECEIVE_HISTORY_RETENTION_MAX_AGE_DAYS,
            DEFAULT_RECEIVE_HISTORY_MAX_AGE_DAYS,
        ),
        maxRowsPerPlayer: positiveInteger(
            environment.RECEIVE_HISTORY_RETENTION_MAX_ROWS,
            DEFAULT_RECEIVE_HISTORY_MAX_ROWS,
        ),
    })
}

function requirePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`)
    }
    return value
}

export function runReceiveHistoryRetentionBatch(
    database: Database,
    now: Date,
    options: ReceiveHistoryRetentionBatchOptions,
): ReceiveHistoryRetentionBatchResult {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new TypeError("now must be a valid Date")
    }
    const maxAgeDays = requirePositiveInteger(options.maxAgeDays, "maxAgeDays")
    const maxRowsPerPlayer = requirePositiveInteger(
        options.maxRowsPerPlayer,
        "maxRowsPerPlayer",
    )
    const batchSize = requirePositiveInteger(
        options.batchSize ?? DEFAULT_RECEIVE_HISTORY_BATCH_SIZE,
        "batchSize",
    )
    const cutoff = clientSerializeDate(new Date(
        now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
    ))

    return database.transaction(() => {
        const deletedExpired = database.prepare(`
            DELETE FROM players_receive_history
            WHERE id IN (
                SELECT id
                FROM players_receive_history
                WHERE create_time < ?
                ORDER BY create_time, id
                LIMIT ?
            )
        `).run(cutoff, batchSize).changes

        const remaining = batchSize - deletedExpired
        const deletedOverflow = remaining <= 0 ? 0 : database.prepare(`
            DELETE FROM players_receive_history
            WHERE id IN (
                SELECT id
                FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY player_id
                        ORDER BY create_time DESC, id DESC
                    ) AS row_number
                    FROM players_receive_history
                )
                WHERE row_number > ?
                ORDER BY id
                LIMIT ?
            )
        `).run(maxRowsPerPlayer, remaining).changes

        const deletedRows = deletedExpired + deletedOverflow
        return Object.freeze({
            deletedExpired,
            deletedOverflow,
            deletedRows,
            hasMore: deletedRows === batchSize,
        })
    })()
}

export async function runReceiveHistoryRetentionPass(
    database: Database,
    now: Date,
    options: ReceiveHistoryRetentionBatchOptions,
    yieldBetweenBatches: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve)),
): Promise<ReceiveHistoryRetentionPassResult> {
    let batches = 0
    let deletedExpired = 0
    let deletedOverflow = 0
    let deletedRows = 0

    while (true) {
        const batch = runReceiveHistoryRetentionBatch(database, now, options)
        batches++
        deletedExpired += batch.deletedExpired
        deletedOverflow += batch.deletedOverflow
        deletedRows += batch.deletedRows
        if (!batch.hasMore) break
        await yieldBetweenBatches()
    }

    return Object.freeze({ batches, deletedExpired, deletedOverflow, deletedRows })
}

export class ReceiveHistoryRetentionService {
    private readonly options: Required<ReceiveHistoryRetentionServiceOptions>
    private readonly getNow: () => Date
    private readonly createTimeout: NonNullable<
        ReceiveHistoryRetentionServiceDependencies["createTimeout"]
    >
    private readonly clearTimeoutHandle: NonNullable<
        ReceiveHistoryRetentionServiceDependencies["clearTimeout"]
    >
    private readonly yieldBetweenBatches: () => Promise<void>
    private readonly logger: Pick<Console, "log" | "warn">
    private running = false
    private timer: RetentionTimer | null = null
    private activePass: Promise<void> | null = null

    constructor(
        private readonly getDatabase: () => Database,
        options: ReceiveHistoryRetentionServiceOptions,
        dependencies: ReceiveHistoryRetentionServiceDependencies = {},
    ) {
        this.options = {
            ...options,
            batchSize: options.batchSize ?? DEFAULT_RECEIVE_HISTORY_BATCH_SIZE,
            initialDelayMs: options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
            intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
        }
        this.getNow = dependencies.getNow ?? (() => new Date())
        this.createTimeout = dependencies.createTimeout
            ?? ((callback, delayMs) => setTimeout(callback, delayMs))
        this.clearTimeoutHandle = dependencies.clearTimeout
            ?? (timer => clearTimeout(timer as NodeJS.Timeout))
        this.yieldBetweenBatches = dependencies.yieldBetweenBatches
            ?? (() => new Promise(resolve => setImmediate(resolve)))
        this.logger = dependencies.logger ?? console
    }

    start(): void {
        if (this.running) return
        this.running = true
        if (!this.options.enabled) return
        this.schedule(this.options.initialDelayMs)
    }

    async stop(): Promise<void> {
        this.running = false
        if (this.timer !== null) {
            this.clearTimeoutHandle(this.timer)
            this.timer = null
        }
        await this.activePass
    }

    private schedule(delayMs: number): void {
        if (!this.running || this.timer !== null || this.activePass !== null) return
        const timer = this.createTimeout(async () => {
            if (this.timer === timer) this.timer = null
            if (!this.running || this.activePass !== null) return
            const activePass = this.runPass()
            this.activePass = activePass
            try {
                await activePass
            } finally {
                if (this.activePass === activePass) this.activePass = null
                if (this.running) this.schedule(this.options.intervalMs)
            }
        }, delayMs)
        timer.unref()
        this.timer = timer
    }

    private async runPass(): Promise<void> {
        try {
            const result = await runReceiveHistoryRetentionPass(
                this.getDatabase(),
                this.getNow(),
                {
                    maxAgeDays: this.options.maxAgeDays,
                    maxRowsPerPlayer: this.options.maxRowsPerPlayer,
                    batchSize: this.options.batchSize,
                },
                this.yieldBetweenBatches,
            )
            this.logger.log(
                `[DB-MAINTENANCE] receive history retention completed: batches=${result.batches} deletedExpired=${result.deletedExpired} deletedOverflow=${result.deletedOverflow} deletedRows=${result.deletedRows}`,
            )
        } catch (error) {
            this.logger.warn(
                `[DB-MAINTENANCE] receive history retention failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }
}
