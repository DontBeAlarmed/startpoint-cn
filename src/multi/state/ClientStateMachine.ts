import { ClientState } from "../types"

const ALLOWED: [ClientState, ClientState][] = [
    [ClientState.Connecting, ClientState.Handshaking],
    [ClientState.Handshaking, ClientState.InLobby],
    [ClientState.Handshaking, ClientState.Disconnected],
    [ClientState.InLobby, ClientState.InBattle],
    [ClientState.InLobby, ClientState.Disconnected],
    [ClientState.InBattle, ClientState.Disconnected],
]

export class ClientStateMachine {
    private state: ClientState

    constructor(initialState: ClientState = ClientState.Connecting) {
        this.state = initialState
    }

    getState(): ClientState { return this.state }

    tryTransition(to: ClientState): { allowed: boolean; reason?: string } {
        const match = ALLOWED.find(([f, t]) => f === this.state && t === to)
        if (!match) return { allowed: false, reason: `INVALID_TRANSITION: ${ClientState[this.state]} → ${ClientState[to]}` }
        this.state = to
        return { allowed: true }
    }
}
