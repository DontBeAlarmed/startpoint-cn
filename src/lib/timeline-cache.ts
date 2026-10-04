import { deepFreeze } from "../content/deep-freeze"
import type { ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import type { GameCalendarPolicy } from "../time/game-calendar"

/**
 * 静态时间线的共享缓存骨架（admin-clairvoyance 与 admin-activity 同款契约）：
 * 以内容仓库身份 × 日历偏移为双键——在某一时区偏移下渲染的时间线，
 * 永远不会供给另一偏移（跨偏移数据不串）。
 */
export class OffsetKeyedStaticTimelineCache<T> {
    readonly #repositoryMap = new WeakMap<ReadonlyContentRepository, Map<number, T>>()
    readonly #build: (repository: ReadonlyContentRepository, calendar: GameCalendarPolicy) => T

    constructor(build: (repository: ReadonlyContentRepository, calendar: GameCalendarPolicy) => T) {
        this.#build = build
    }

    get(repository: ReadonlyContentRepository, calendar: GameCalendarPolicy): T {
        let byOffset = this.#repositoryMap.get(repository)
        if (byOffset === undefined) {
            byOffset = new Map<number, T>()
            this.#repositoryMap.set(repository, byOffset)
        }
        const cached = byOffset.get(calendar.utcOffsetMinutes)
        if (cached !== undefined) return cached
        const built = this.#build(repository, calendar)
        byOffset.set(calendar.utcOffsetMinutes, built)
        return built
    }
}

/** 同构时间线产物的冻结收口（timeline + searchIndex 双数组）。 */
export function freezeTimeline<T extends { timeline: readonly unknown[]; searchIndex: readonly unknown[] }>(
    value: T,
): Readonly<T> {
    return deepFreeze(value)
}
