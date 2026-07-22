type LobbyTimer = ReturnType<typeof setTimeout>

export interface LobbyLifecycleOptions {
    createTimer?: (callback: () => void, delayMs: number) => LobbyTimer
    clearTimer?: (timer: LobbyTimer) => void
}

export interface LobbyLifecycleStatus {
    readonly running: boolean
    readonly activeTimers: number
}

export interface LobbyLifecycleGuard {
    readonly generation: number
    isActive(): boolean
}

interface TrackedTimer {
    readonly timer: LobbyTimer
    readonly clear: (timer: LobbyTimer) => void
}

let running = false
let generation = 0
let createTimer: (callback: () => void, delayMs: number) => LobbyTimer = setTimeout
let clearTimer: (timer: LobbyTimer) => void = clearTimeout
const timers = new Map<LobbyTimer, TrackedTimer>()

export function startLobbyLifecycle(options: LobbyLifecycleOptions = {}): void {
    if (running) return
    running = true
    generation++
    createTimer = options.createTimer ?? setTimeout
    clearTimer = options.clearTimer ?? clearTimeout
}

export function getLobbyLifecycleGuard(): LobbyLifecycleGuard {
    const capturedGeneration = generation
    return Object.freeze({
        generation: capturedGeneration,
        isActive: () => running && generation === capturedGeneration,
    })
}

export function scheduleLobbyTask(
    callback: (lifecycle: LobbyLifecycleGuard) => void,
    delayMs: number,
): boolean {
    if (!running) return false
    const lifecycle = getLobbyLifecycleGuard()
    let timer!: LobbyTimer
    const wrapped = (): void => {
        timers.delete(timer)
        if (lifecycle.isActive()) callback(lifecycle)
    }
    timer = createTimer(wrapped, delayMs)
    const tracked = { timer, clear: clearTimer }
    timers.set(timer, tracked)
    try {
        timer.unref()
    } catch (error) {
        timers.delete(timer)
        tracked.clear(timer)
        throw error
    }
    return true
}

export function stopLobbyLifecycle(): void {
    running = false
    for (const tracked of timers.values()) tracked.clear(tracked.timer)
    timers.clear()
    createTimer = setTimeout
    clearTimer = clearTimeout
}

export function getLobbyLifecycleStatus(): LobbyLifecycleStatus {
    return Object.freeze({ running, activeTimers: timers.size })
}
