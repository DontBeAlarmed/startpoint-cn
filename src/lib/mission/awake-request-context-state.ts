import type { PlayerActiveMission } from "../../data/types"
import type { AwakeRequestContext } from "./awake-request-context"
import type { AwakeUnlockProgress } from "./awake-unlock"

interface AwakeRequestContextState {
    readonly playerId: number
    readonly supportedMissionIds: ReadonlySet<number>
    readonly categoryMissions: Readonly<Record<string, PlayerActiveMission>>
    consumed: boolean
}

const states = new WeakMap<object, AwakeRequestContextState>()

export function registerAwakeRequestContext(
    context: AwakeRequestContext,
    state: Omit<AwakeRequestContextState, "consumed">,
): void {
    states.set(context, { ...state, consumed: false })
}

export function isAwakeRequestContext(value: unknown): value is AwakeRequestContext {
    return value !== null && typeof value === "object" && states.has(value)
}

export function assertAwakeRequestContext(
    context: AwakeRequestContext,
    playerId: number,
): asserts context is AwakeRequestContext {
    const state = states.get(context)
    if (!state) {
        throw new TypeError("Awake context is invalid; use createAwakeRequestContext factory")
    }
    if (state.playerId !== playerId || context.playerId !== playerId) {
        throw new Error(
            `Awake context player mismatch: expected ${playerId}, received ${context.playerId}`,
        )
    }
}

export function readAwakeRequestContextCategoryMissions(
    context: AwakeRequestContext,
): Readonly<Record<string, PlayerActiveMission>> {
    assertAwakeRequestContext(context, context.playerId)
    return states.get(context)!.categoryMissions
}

export function consumeAwakeRequestContextWrite(
    context: AwakeRequestContext,
    playerId: number,
    progressList: readonly AwakeUnlockProgress[],
): void {
    assertAwakeRequestContext(context, playerId)
    const state = states.get(context)!
    for (const entry of progressList) {
        if (!state.supportedMissionIds.has(entry.missionId)) {
            throw new Error(
                `Awake mission ${entry.missionId} is outside the frozen context scope`,
            )
        }
    }
    if (state.consumed) {
        throw new Error("Awake request context write lifecycle was already consumed")
    }
    state.consumed = true
}
