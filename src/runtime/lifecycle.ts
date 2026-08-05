import type { AssetMode } from "../content/cdn/asset-mode"
import type { CnRuntimeConfig } from "./config"
import { unavailableMultiRuntimeStatus } from "../multi/runtime/status"
import {
    createRuntimeHealthSnapshot,
    RuntimeHealthSnapshot,
    RuntimePhase,
} from "./health"

export type RuntimeStartupStage =
    | "config"
    | "runtime-pack"
    | "database"
    | "http"
    | "tcp"
    | "multi"
    | "content"
    | "unknown"

type Awaitable<T> = T | Promise<T>

export interface RuntimeSignalTarget {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

export interface RuntimeCoordinatorDependencies {
    readonly loadConfig: () => CnRuntimeConfig
    readonly configureHttp: (config: CnRuntimeConfig) => void
    readonly initializeDatabase: () => void
    readonly restoreTimeOffset: () => void
    readonly initializeContent: (config: CnRuntimeConfig) => Promise<unknown>
    readonly readyHttp: () => Promise<unknown>
    readonly listenHttp: (config: CnRuntimeConfig) => Promise<unknown>
    readonly closeHttp: () => Awaitable<unknown>
    readonly forceCloseHttp: () => Awaitable<unknown>
    readonly startMulti: (config: CnRuntimeConfig) => Promise<unknown>
    readonly stopMulti: () => Awaitable<unknown>
    readonly checkpointDatabase: () => Awaitable<unknown>
    readonly closeDatabase: () => Awaitable<unknown>
    readonly getDatabaseHealth: () => { readonly ready: boolean; readonly schema: number | null }
    readonly isHttpListening: () => boolean
    readonly getMultiStatus: () => ReturnType<typeof unavailableMultiRuntimeStatus>
    readonly processTarget: RuntimeSignalTarget
    readonly setExitCode: (code: number) => void
    readonly bundleVersion: string
    readonly bundleId: string | null
    readonly nodeVersion: string
    readonly adminAvailable: boolean
    readonly shutdownStepTimeoutMs?: number
    readonly reportStartupFailure?: (stage: RuntimeStartupStage) => void
    readonly reportShutdownFailures?: (failures: readonly RuntimeShutdownFailure[]) => void
    readonly reportShutdownComplete?: () => void
}

export type RuntimeShutdownStep =
    | "http-close"
    | "http-force-close"
    | "multi-stop"
    | "database-checkpoint"
    | "database-close"

export interface RuntimeShutdownFailure {
    readonly step: RuntimeShutdownStep
    readonly code: string | null
}

export interface RuntimeCoordinator {
    start(): Promise<void>
    stop(): Promise<void>
    getPhase(): RuntimePhase
    getHealthSnapshot(): RuntimeHealthSnapshot
}

const EXIT_CODES: Readonly<Record<RuntimeStartupStage, number>> = Object.freeze({
    config: 10,
    "runtime-pack": 11,
    database: 12,
    http: 13,
    tcp: 14,
    multi: 14,
    content: 15,
    unknown: 1,
})

export function startupExitCode(stage: RuntimeStartupStage): number {
    return EXIT_CODES[stage]
}

class Coordinator implements RuntimeCoordinator {
    private phase: RuntimePhase = "stopped"
    private stage: RuntimeStartupStage = "unknown"
    private config: CnRuntimeConfig | null = null
    private databaseInitialized = false
    private contentInitialized = false
    private httpAttempted = false
    private multiAttempted = false
    private shutdownRequested = false
    private signalsRegistered = false
    private startPromise: Promise<void> | null = null
    private stopPromise: Promise<void> | null = null
    private terminalExitCode: number | null = null

    private readonly onSigint = (): void => { void this.requestShutdown() }
    private readonly onSigterm = (): void => { void this.requestShutdown() }
    constructor(private readonly dependencies: RuntimeCoordinatorDependencies) {}

    start(): Promise<void> {
        if (this.startPromise !== null) return this.startPromise
        this.shutdownRequested = false
        this.terminalExitCode = null
        this.phase = "starting"
        this.startPromise = this.runStartup()
        return this.startPromise
    }

    stop(): Promise<void> {
        return this.requestShutdown()
    }

    private requestShutdown(): Promise<void> {
        if (this.stopPromise !== null) return this.stopPromise
        if (this.startPromise === null && !this.hasCleanupWork()) {
            this.phase = "stopped"
            return Promise.resolve()
        }
        if (this.phase === "stopped" && !this.hasCleanupWork()) return Promise.resolve()
        if (this.phase === "failed" && this.terminalExitCode !== null && !this.hasCleanupWork()) {
            return Promise.resolve()
        }
        this.shutdownRequested = true
        if (this.terminalExitCode === null) this.phase = "stopping"
        let tracked!: Promise<void>
        tracked = this.runShutdown().finally(() => {
            if (this.stopPromise === tracked) this.stopPromise = null
        })
        this.stopPromise = tracked
        return tracked
    }

    getPhase(): RuntimePhase {
        return this.phase
    }

    getHealthSnapshot(): RuntimeHealthSnapshot {
        let database = { ready: false, schema: null as number | null }
        let httpListening = false
        let multi = unavailableMultiRuntimeStatus(this.config?.multi.mode)
        try { database = this.dependencies.getDatabaseHealth() } catch { /* unavailable */ }
        try { httpListening = this.dependencies.isHttpListening() } catch { /* unavailable */ }
        try { multi = this.dependencies.getMultiStatus() } catch { /* unavailable */ }
        const assetMode: AssetMode = this.config?.assetProvider.mode ?? "client-owned"
        return createRuntimeHealthSnapshot({
            phase: this.phase,
            bundleVersion: this.dependencies.bundleVersion,
            bundleId: this.dependencies.bundleId,
            nodeVersion: this.dependencies.nodeVersion,
            database,
            contentInitialized: this.contentInitialized,
            httpListening,
            multi,
            adminAvailable: this.dependencies.adminAvailable,
            assetMode,
        })
    }

    private registerSignals(): void {
        if (this.signalsRegistered) return
        let sigintRegistered = false
        try {
            this.dependencies.processTarget.on("SIGINT", this.onSigint)
            sigintRegistered = true
            this.dependencies.processTarget.on("SIGTERM", this.onSigterm)
            this.signalsRegistered = true
        } catch (error) {
            if (sigintRegistered) {
                this.dependencies.processTarget.removeListener("SIGINT", this.onSigint)
            }
            throw error
        }
    }

    private removeSignals(): void {
        if (!this.signalsRegistered) return
        this.dependencies.processTarget.removeListener("SIGINT", this.onSigint)
        this.dependencies.processTarget.removeListener("SIGTERM", this.onSigterm)
        this.signalsRegistered = false
    }

    private interrupted(): boolean {
        return this.shutdownRequested
    }

    private async runStartup(): Promise<void> {
        try {
            this.registerSignals()
            this.stage = "config"
            this.config = this.dependencies.loadConfig()
            if (this.interrupted()) return

            this.stage = "database"
            this.dependencies.initializeDatabase()
            this.databaseInitialized = true
            this.dependencies.restoreTimeOffset()
            if (this.interrupted()) return

            this.stage = "content"
            await this.dependencies.initializeContent(this.config)
            this.contentInitialized = true
            if (this.interrupted()) return

            this.stage = this.config.multi.mode === "embedded" ? "tcp" : "multi"
            this.multiAttempted = true
            try {
                await this.dependencies.startMulti(this.config)
            } catch (error) {
                if (this.config.multi.mode === "embedded") throw error
                // Host and client multiplayer are optional; health exposes degradation.
            }
            if (this.interrupted()) return

            this.stage = "http"
            this.httpAttempted = true
            this.dependencies.configureHttp(this.config)
            if (this.interrupted()) return
            await this.dependencies.readyHttp()
            if (this.interrupted()) return
            await this.dependencies.listenHttp(this.config)
            if (this.interrupted()) return

            this.phase = "ready"
        } catch {
            if (this.interrupted()) return
            this.phase = "failed"
            this.terminalExitCode = startupExitCode(this.stage)
            const failures = await this.cleanupStartupFailure()
            if (failures.length > 0) this.dependencies.reportShutdownFailures?.(failures)
            this.dependencies.reportStartupFailure?.(this.stage)
            this.dependencies.setExitCode(this.terminalExitCode)
            if (!this.hasCleanupWork()) this.removeSignals()
        }
    }

    private safeFailure(step: RuntimeShutdownStep, error: unknown): RuntimeShutdownFailure {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code
        const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
            ? rawCode
            : null
        return Object.freeze({ step, code })
    }

    private async runStep(
        step: RuntimeShutdownStep,
        operation: () => Awaitable<unknown>,
        failures: RuntimeShutdownFailure[],
    ): Promise<boolean> {
        try {
            await operation()
            return true
        } catch (error) {
            failures.push(this.safeFailure(step, error))
            return false
        }
    }

    private shutdownStepTimeoutMs(): number {
        return Number.isSafeInteger(this.dependencies.shutdownStepTimeoutMs)
            && (this.dependencies.shutdownStepTimeoutMs as number) > 0
            ? this.dependencies.shutdownStepTimeoutMs as number
            : 5_000
    }

    private async runBoundedStep(
        step: RuntimeShutdownStep,
        operation: () => Awaitable<unknown>,
        failures: RuntimeShutdownFailure[],
    ): Promise<boolean> {
        const operationResult = Promise.resolve()
            .then(operation)
            .then(
                () => ({ status: "completed" as const }),
                error => ({ status: "failed" as const, error }),
            )
        let timeout!: NodeJS.Timeout
        const timeoutResult = new Promise<{ status: "timeout" }>(resolve => {
            timeout = setTimeout(
                () => resolve({ status: "timeout" }),
                this.shutdownStepTimeoutMs(),
            )
            timeout.unref()
        })
        const result = await Promise.race([operationResult, timeoutResult])
        clearTimeout(timeout)
        if (result.status === "completed") return true
        failures.push(result.status === "timeout"
            ? Object.freeze({ step, code: "TIMEOUT" })
            : this.safeFailure(step, result.error))
        return false
    }

    private async closeHttpBounded(failures: RuntimeShutdownFailure[]): Promise<void> {
        if (!this.httpAttempted) return
        if (await this.runBoundedStep(
            "http-close",
            () => this.dependencies.closeHttp(),
            failures,
        )) {
            this.httpAttempted = false
            return
        }
        const forced = await this.runBoundedStep(
            "http-force-close",
            () => this.dependencies.forceCloseHttp(),
            failures,
        )
        if (forced) this.httpAttempted = false
    }

    private async stopMulti(failures: RuntimeShutdownFailure[]): Promise<void> {
        if (!this.multiAttempted) return
        if (await this.runBoundedStep(
            "multi-stop",
            () => this.dependencies.stopMulti(),
            failures,
        )) {
            this.multiAttempted = false
        }
    }

    private async closeDatabase(failures: RuntimeShutdownFailure[]): Promise<void> {
        if (this.databaseInitialized) {
            await this.runStep(
                "database-checkpoint",
                () => this.dependencies.checkpointDatabase(),
                failures,
            )
            if (await this.runStep("database-close", () => this.dependencies.closeDatabase(), failures)) {
                this.databaseInitialized = false
            }
        }
    }

    private async cleanupStartupFailure(): Promise<RuntimeShutdownFailure[]> {
        const failures: RuntimeShutdownFailure[] = []
        await this.closeHttpBounded(failures)
        await this.stopMulti(failures)
        await this.closeDatabase(failures)
        return failures
    }

    private hasCleanupWork(): boolean {
        return this.httpAttempted || this.multiAttempted || this.databaseInitialized
    }

    private async runShutdown(): Promise<void> {
        const failures: RuntimeShutdownFailure[] = []
        await this.closeHttpBounded(failures)
        await this.stopMulti(failures)
        if (this.startPromise !== null) await this.startPromise
        await this.closeDatabase(failures)
        this.contentInitialized = false
        if (failures.length > 0) {
            // Cleanup retries may release handles, but they cannot restore a successful exit.
            if (this.terminalExitCode === null) this.terminalExitCode = 1
            this.dependencies.reportShutdownFailures?.(failures)
        }

        if (this.terminalExitCode !== null) {
            this.phase = "failed"
            this.dependencies.setExitCode(this.terminalExitCode)
        } else if (failures.length === 0 && !this.hasCleanupWork()) {
            this.phase = "stopped"
            this.dependencies.setExitCode(0)
            this.dependencies.reportShutdownComplete?.()
        } else {
            this.phase = "failed"
            this.dependencies.setExitCode(1)
        }
        if (!this.hasCleanupWork()) this.removeSignals()
    }
}

export function createRuntimeCoordinator(
    dependencies: RuntimeCoordinatorDependencies,
): RuntimeCoordinator {
    return new Coordinator(dependencies)
}
