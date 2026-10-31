// 切片 2 步 2d:统一清理调度器(注册制+可观测,行为不变)。
// 房间老化/GC/closing/启动清扫/节点会话清理/结算事实 prune 等清理路径
// 在此注册:任务要么由本调度器的主 tick 驱动(scheduler-driven),要么保留
// 自有定时器但经 recordCleanupRun 上报(externally-driven)——两类都进同一
// 可观测面(名称/间隔/最近运行/次数),经 server/status 暴露。
// 显式排除(非本节点/非定时器):hub 幂等缓存(client 模式 hub 侧)、
// share/recruit TTL(DB 行按 recency 查询,无定时器)。排除项在注册表中
// 以 excluded 名义登记,保证"哪条清理路径在哪"只有一个答案。

export interface CleanupTaskRegistration {
    readonly name: string
    /** 期望运行间隔(观测口径);scheduler-driven 任务的发牌间隔 */
    readonly intervalMs: number
    /** scheduler-driven 任务的主 tick 回调;externally-driven 省略 */
    readonly task?: (nowMs: number) => void
    /** externally-driven:任务自带定时器,仅经 recordCleanupRun 上报 */
    readonly externallyDriven?: boolean
    /** 显式排除:登记原因,主 tick 不驱动、不上报 */
    readonly excludedReason?: string
}

interface CleanupTaskState {
    readonly registration: CleanupTaskRegistration
    lastRunAtMs: number | null
    runCount: number
    lastErrorAtMs: number | null
    lastError: string | null
}

const tasks = new Map<string, CleanupTaskState>()
let masterTimer: ReturnType<typeof setInterval> | null = null
let masterIntervalMs: number | null = null

function upsert(registration: CleanupTaskRegistration): CleanupTaskState {
    const existing = tasks.get(registration.name)
    if (existing) {
        tasks.set(registration.name, { ...existing, registration })
        return tasks.get(registration.name) as CleanupTaskState
    }
    const state: CleanupTaskState = {
        registration,
        lastRunAtMs: null,
        runCount: 0,
        lastErrorAtMs: null,
        lastError: null,
    }
    tasks.set(registration.name, state)
    return state
}

export function registerCleanupTask(registration: CleanupTaskRegistration): void {
    if (!registration.name || registration.name.length > 64) {
        throw new TypeError("cleanup task name must be 1-64 chars")
    }
    if (registration.excludedReason !== undefined) {
        upsert(registration)
        return
    }
    if (!Number.isSafeInteger(registration.intervalMs) || registration.intervalMs <= 0) {
        throw new TypeError("cleanup task intervalMs must be a positive safe integer")
    }
    if (!registration.externallyDriven && typeof registration.task !== "function") {
        throw new TypeError("scheduler-driven cleanup tasks require a task callback")
    }
    upsert(registration)
}

/** externally-driven 任务每次运行后上报(含失败)。 */
export function recordCleanupRun(name: string, nowMs: number, error?: string): void {
    const state = tasks.get(name)
    if (!state) return
    state.lastRunAtMs = nowMs
    state.runCount += 1
    if (error !== undefined) {
        state.lastErrorAtMs = nowMs
        state.lastError = error.slice(0, 160)
    }
}

function runSchedulerDrivenTasks(nowMs: number): void {
    for (const state of tasks.values()) {
        const { registration } = state
        if (registration.excludedReason !== undefined) continue
        if (registration.externallyDriven || !registration.task) continue
        if (state.lastRunAtMs !== null
            && nowMs - state.lastRunAtMs < registration.intervalMs) continue
        state.lastRunAtMs = nowMs
        state.runCount += 1
        try {
            registration.task(nowMs)
        } catch (error) {
            state.lastErrorAtMs = nowMs
            state.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 160)
        }
    }
}

/** 启动主 tick(单一 interval;所有 scheduler-driven 任务按各自间隔发牌)。 */
export function startCleanupScheduler(intervalMs = 60_000): void {
    if (masterTimer) return
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new TypeError("cleanup scheduler intervalMs must be a positive safe integer")
    }
    masterIntervalMs = intervalMs
    masterTimer = setInterval(() => {
        runSchedulerDrivenTasks(Date.now())
    }, intervalMs)
    try {
        masterTimer.unref()
    } catch {
        // 环境 不支持 unref(罕见):保留定时器
    }
}

export function stopCleanupScheduler(): void {
    if (masterTimer) clearInterval(masterTimer)
    masterTimer = null
    masterIntervalMs = null
}

export interface CleanupSchedulerTaskStatus {
    readonly name: string
    readonly intervalMs: number | null
    readonly mode: "scheduler" | "external" | "excluded"
    readonly lastRunAtMs: number | null
    readonly runCount: number
    readonly lastErrorAtMs: number | null
    readonly lastError: string | null
}

export function getCleanupSchedulerStatus(): {
    readonly running: boolean
    readonly masterIntervalMs: number | null
    readonly tasks: readonly CleanupSchedulerTaskStatus[]
} {
    return Object.freeze({
        running: masterTimer !== null,
        masterIntervalMs,
        tasks: Object.freeze([...tasks.values()].map(state => Object.freeze({
            name: state.registration.name,
            intervalMs: state.registration.excludedReason === undefined ? state.registration.intervalMs : null,
            mode: state.registration.excludedReason !== undefined
                ? "excluded" as const
                : state.registration.externallyDriven === true
                    ? "external" as const
                    : "scheduler" as const,
            lastRunAtMs: state.lastRunAtMs,
            runCount: state.runCount,
            lastErrorAtMs: state.lastErrorAtMs,
            lastError: state.lastError,
        }))),
    })
}

/** 测试钩子:直接驱动发牌循环(不经真实 interval)。 */
export function runSchedulerDrivenTasksForTest(nowMs: number): void {
    runSchedulerDrivenTasks(nowMs)
}

/** 测试隔离。 */
export function resetCleanupSchedulerForTest(): void {
    stopCleanupScheduler()
    tasks.clear()
}
