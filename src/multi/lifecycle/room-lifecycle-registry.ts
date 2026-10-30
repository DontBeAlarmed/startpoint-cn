// 生命周期内核的宿主注册表（B2a，影子模式）。
// 只记录内核状态，不执行效果、不改任何既有行为；B3 起内核才成为权威。

import {
    createLifecycle,
    decide,
    type RoomEvent,
    type RoomLifecycleDecision,
    type RoomLifecycleState,
} from "./room-lifecycle"

/** 房间资源上界：结算后 15 分钟、closing 后 5 分钟（只回收，不推导状态）。 */
export const LIFECYCLE_BATTLE_DEADLINE_MS = 900_000
export const LIFECYCLE_CLOSE_DEADLINE_MS = 5 * 60_000

/** 房间内的逻辑玩家身份：viewer 维度，跨 socket 重连保持不变。 */
export function identityOf(participant: { viewerId: number }): string {
    return `viewer:${participant.viewerId}`
}

export interface ClosingEntryDiagnostics {
    readonly roomNumber: string
    readonly ageMs: number
    readonly pendingIdentities: readonly string[]
}

export class RoomLifecycleRegistry {
    private rooms = new Map<string, RoomLifecycleState>()
    private nextGeneration = 1
    private rejections = 0

    create(roomNumber: string, host: string, npcCount = 0): RoomLifecycleState {
        const state = createLifecycle({
            roomNumber,
            generation: this.nextGeneration++,
            host,
            npcCount,
        })
        this.rooms.set(roomNumber, state)
        return state
    }

    get(roomNumber: string): RoomLifecycleState | undefined {
        return this.rooms.get(roomNumber)
    }

    hostOf(roomNumber: string): string | undefined {
        return this.rooms.get(roomNumber)?.host
    }

    dispatch(
        roomNumber: string,
        build: (generation: number) => RoomEvent,
        generationOverride?: number,
    ): RoomLifecycleDecision | null {
        const state = this.rooms.get(roomNumber)
        if (!state) return null
        const event = build(generationOverride ?? state.generation)
        const decision = decide(state, event)
        if (decision.rejected) {
            this.rejections++
            if (process.env.MULTI_LIFECYCLE_SHADOW_LOG === "1") {
                console.log(`[LIFECYCLE] reject room=${roomNumber} event=${event.type} reason=${decision.rejected}`)
            }
        }
        if (decision.state !== state) this.rooms.set(roomNumber, decision.state)
        return decision
    }

    remove(roomNumber: string): void {
        this.rooms.delete(roomNumber)
    }

    reset(): void {
        this.rooms.clear()
        this.nextGeneration = 1
        this.rejections = 0
    }

    stats(): { readonly rooms: number; readonly rejections: number } {
        return { rooms: this.rooms.size, rejections: this.rejections }
    }

    /** 清掉超过 closing 期限仍未确认的 detached closing（资源回收，不推导状态）。 */
    sweepClosing(nowMs: number, deadlineMs: number): number {
        let removed = 0
        for (const [roomNumber, state] of this.rooms) {
            if (state.phase !== "closing" || state.closingAtMs === null) continue
            if (nowMs - state.closingAtMs < deadlineMs) continue
            this.rooms.delete(roomNumber)
            removed++
        }
        return removed
    }

    /** closing 条目的只读诊断：年龄与尚未确认的身份（不改变状态）。 */
    closingEntries(nowMs: number): readonly ClosingEntryDiagnostics[] {
        const entries: ClosingEntryDiagnostics[] = []
        for (const [roomNumber, state] of this.rooms) {
            if (state.phase !== "closing" || state.closingAtMs === null) continue
            const pending = new Set<string>([
                ...state.seats,
                ...state.battleParticipants,
                ...Object.keys(state.joiners),
            ])
            for (const identity of state.dismissed) pending.delete(identity)
            entries.push(Object.freeze({
                roomNumber,
                ageMs: Math.max(0, nowMs - state.closingAtMs),
                pendingIdentities: Object.freeze([...pending]),
            }))
        }
        return Object.freeze(entries)
    }

    get size(): number {
        return this.rooms.size
    }
}

export const lifecycleRegistry = new RoomLifecycleRegistry()
