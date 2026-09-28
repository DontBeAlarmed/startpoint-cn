import { RoomState } from "../types"

const ALLOWED_TRANSITIONS: [RoomState, RoomState][] = [
    [RoomState.Waiting, RoomState.Ready],
    [RoomState.Ready, RoomState.Filled],
    [RoomState.Ready, RoomState.Disbanded],
    [RoomState.Filled, RoomState.Battle],
    [RoomState.Ready, RoomState.Battle],
    [RoomState.Filled, RoomState.Ready],
    [RoomState.Filled, RoomState.Disbanded],
    [RoomState.Battle, RoomState.Ready],
    [RoomState.Battle, RoomState.Disbanded],
]

export class RoomStateMachine {
    private state: RoomState = RoomState.Waiting

    constructor(initialState?: RoomState) {
        if (initialState !== undefined) this.state = initialState
    }

    getState(): RoomState { return this.state }

    /** Dry-run of tryTransition, including the same-state rewrite updateRoomState allows. */
    canTransition(to: RoomState): boolean {
        return this.state === to
            || ALLOWED_TRANSITIONS.some(([from, target]) => from === this.state && target === to)
    }

    tryTransition(to: RoomState, guard?: () => boolean): { allowed: boolean; reason?: string } {
        const match = ALLOWED_TRANSITIONS.find(([f, t]) => f === this.state && t === to)
        if (!match) return { allowed: false, reason: `INVALID_TRANSITION: ${RoomState[this.state]} → ${RoomState[to]}` }
        if (guard && !guard()) return { allowed: false, reason: "GUARD_FAILED" }
        this.state = to
        return { allowed: true }
    }
}
