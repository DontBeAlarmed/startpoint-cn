import { RoomState } from "../types"

export class RoomStateMachine {
    private state: RoomState = RoomState.Waiting

    constructor(initialState?: RoomState) {
        if (initialState !== undefined) this.state = initialState
    }

    getState(): RoomState { return this.state }

    tryTransition(to: RoomState, guard?: () => boolean): { allowed: boolean; reason?: string } {
        const allowed: [RoomState, RoomState][] = [
            [RoomState.Waiting, RoomState.Ready],
            [RoomState.Ready, RoomState.Filled],
            [RoomState.Ready, RoomState.Disbanded],
            [RoomState.Filled, RoomState.Battle],
            [RoomState.Filled, RoomState.Ready],
            [RoomState.Filled, RoomState.Disbanded],
            [RoomState.Battle, RoomState.Ready],
            [RoomState.Battle, RoomState.Disbanded],
        ]
        const match = allowed.find(([f, t]) => f === this.state && t === to)
        if (!match) return { allowed: false, reason: `INVALID_TRANSITION: ${RoomState[this.state]} → ${RoomState[to]}` }
        if (guard && !guard()) return { allowed: false, reason: "GUARD_FAILED" }
        this.state = to
        return { allowed: true }
    }
}
