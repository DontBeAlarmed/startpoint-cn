// 房间生命周期纯域模型（B1）。
// 只做决定，不做 I/O：不 import net/setTimeout/sessionManager/DB。
// 外壳把 TCP/HTTP/定时器事件翻译成 RoomEvent，执行 decide() 返回的效果。

export type RoomPhase = "recruiting" | "ready" | "battle" | "closing" | "closed"
export type JoinPhase = "admitted" | "handshaked" | "entered"
export type Identity = string

export interface RoomLifecycleState {
    readonly roomNumber: string
    readonly generation: number
    readonly phase: RoomPhase
    readonly host: Identity
    /** 当前占座（含房主）；容量 = 3 - npcCount，只算真人 */
    readonly seats: readonly Identity[]
    readonly ready: readonly Identity[]
    /** 入房流水线：admitted → handshaked → entered（closing 期间保留在途者） */
    readonly joiners: Readonly<Record<Identity, JoinPhase>>
    /** 上一场参战者；state 4 的服务矩阵用它判断“成员”，直到 HostReturn 清空 */
    readonly battleParticipants: readonly Identity[]
    readonly finished: readonly Identity[]
    readonly battleSessionId: string | null
    readonly battleFinalized: boolean
    readonly npcCount: number
    readonly hostOnline: boolean
    readonly hostEntryTimeMs: number | null
    readonly finishedAtMs: number | null
    readonly closingAtMs: number | null
    readonly dismissed: readonly Identity[]
}

export type RoomEvent =
    | { readonly type: "admit"; readonly generation: number; readonly identity: Identity }
    | { readonly type: "handshake"; readonly generation: number; readonly identity: Identity }
    | { readonly type: "enter"; readonly generation: number; readonly identity: Identity; readonly nowMs: number }
    | { readonly type: "ready"; readonly generation: number; readonly identity: Identity; readonly ready: boolean }
    | {
        readonly type: "startBattle"
        readonly generation: number
        readonly identity: Identity
        readonly battleSessionId: string
    }
    | {
        readonly type: "finish"
        readonly generation: number
        readonly identity: Identity
        readonly nowMs: number
        readonly battleDeadlineMs: number
    }
    | {
        readonly type: "abort"
        readonly generation: number
        readonly identity: Identity
        readonly nowMs: number
        readonly battleDeadlineMs: number
        readonly closeDeadlineMs: number
    }
    | { readonly type: "hostReturn"; readonly generation: number; readonly identity: Identity; readonly nowMs: number }
    | {
        readonly type: "disband"
        readonly generation: number
        readonly identity: Identity | null
        readonly nowMs: number
        readonly closeDeadlineMs: number
    }
    | { readonly type: "socketLost"; readonly generation: number; readonly identity: Identity }
    | { readonly type: "closeConfirmed"; readonly generation: number; readonly identity: Identity }
    | {
        readonly type: "gcSweep"
        readonly generation: number
        readonly nowMs: number
        readonly battleDeadlineMs: number
        readonly closeDeadlineMs: number
    }

export type RoomEffect =
    | { readonly type: "sendEnterReply"; readonly identity: Identity }
    | { readonly type: "sendDismiss"; readonly identity: Identity }
    | { readonly type: "broadcastMates" }
    | { readonly type: "releaseSeats" }
    | { readonly type: "persistBattleRelease" }
    | { readonly type: "updateShareRow" }
    | { readonly type: "closeRecruitment" }
    | { readonly type: "scheduleGc"; readonly ms: number }
    | { readonly type: "closeRoom" }

export interface RoomLifecycleDecision {
    readonly state: RoomLifecycleState
    readonly effects: readonly RoomEffect[]
    readonly rejected?: string
}

export const MAX_REAL_SEATS = 3

export interface CreateLifecycleInput {
    readonly roomNumber: string
    readonly generation: number
    readonly host: Identity
    readonly npcCount?: number
}

export function createLifecycle(input: CreateLifecycleInput): RoomLifecycleState {
    const npcCount = Math.max(0, Math.trunc(input.npcCount ?? 0))
    return {
        roomNumber: input.roomNumber,
        generation: input.generation,
        phase: "recruiting",
        host: input.host,
        seats: [input.host],
        ready: [],
        joiners: {},
        battleParticipants: [],
        finished: [],
        battleSessionId: null,
        battleFinalized: false,
        npcCount,
        hostOnline: true,
        hostEntryTimeMs: null,
        finishedAtMs: null,
        closingAtMs: null,
        dismissed: [],
    }
}

export function capacityOf(state: RoomLifecycleState): number {
    return Math.max(1, MAX_REAL_SEATS - state.npcCount)
}

export function projectRaisingState(state: RoomLifecycleState): 1 | 2 | 4 | 9 {
    if (state.phase === "battle") return 4
    if (state.phase === "closing" || state.phase === "closed") return 9
    if (state.phase === "ready" && state.hostOnline) return 1
    return 2
}

export function isJoinable(state: RoomLifecycleState): boolean {
    if (state.phase !== "recruiting" && state.phase !== "ready") return false
    return state.seats.length + Object.keys(state.joiners).length < capacityOf(state)
}

export function isServingMember(state: RoomLifecycleState, identity: Identity): boolean {
    if (state.phase === "battle") return state.battleParticipants.includes(identity)
    if (state.phase === "recruiting" || state.phase === "ready") return state.seats.includes(identity)
    return false
}

export function isVisibleInList(state: RoomLifecycleState): boolean {
    return state.phase !== "closing" && state.phase !== "closed"
}

function reject(state: RoomLifecycleState, reason: string): RoomLifecycleDecision {
    return { state, effects: [], rejected: reason }
}

function unique(identities: readonly Identity[]): Identity[] {
    return [...new Set(identities)]
}

function addIdentity(list: readonly Identity[], identity: Identity): Identity[] {
    return list.includes(identity) ? [...list] : [...list, identity]
}

function removeIdentity(list: readonly Identity[], identity: Identity): Identity[] {
    return list.filter(item => item !== identity)
}

function withJoiner(
    joiners: Readonly<Record<Identity, JoinPhase>>,
    identity: Identity,
    phase: JoinPhase,
): Record<Identity, JoinPhase> {
    return { ...joiners, [identity]: phase }
}

function withoutJoiner(
    joiners: Readonly<Record<Identity, JoinPhase>>,
    identity: Identity,
): Record<Identity, JoinPhase> {
    const next = { ...joiners }
    delete next[identity]
    return next
}

function knownIdentities(state: RoomLifecycleState): Identity[] {
    return unique([...state.seats, ...state.battleParticipants, ...Object.keys(state.joiners)])
}

function finalizeBattle(
    state: RoomLifecycleState,
    finished: readonly Identity[],
    nowMs: number,
): RoomLifecycleState {
    return {
        ...state,
        finished,
        battleFinalized: true,
        finishedAtMs: nowMs,
        seats: [state.host],
        ready: [],
    }
}

function enterClosing(
    state: RoomLifecycleState,
    nowMs: number,
    closeDeadlineMs: number,
): RoomLifecycleDecision {
    if (state.phase === "closing") return { state, effects: [] }
    const effects: RoomEffect[] = knownIdentities(state).map(identity => ({
        type: "sendDismiss" as const,
        identity,
    }))
    effects.push(
        { type: "closeRecruitment" },
        { type: "broadcastMates" },
        { type: "updateShareRow" },
        { type: "scheduleGc", ms: closeDeadlineMs },
    )
    return {
        state: {
            ...state,
            phase: "closing",
            closingAtMs: nowMs,
            dismissed: [],
        },
        effects,
    }
}

function confirmClosed(state: RoomLifecycleState, identity: Identity): RoomLifecycleDecision {
    const dismissed = addIdentity(state.dismissed, identity)
    const known = knownIdentities(state)
    if (!known.every(item => dismissed.includes(item))) {
        return { state: { ...state, dismissed }, effects: [] }
    }
    return {
        state: { ...state, dismissed, phase: "closed" },
        effects: [{ type: "closeRoom" }],
    }
}

export function decide(state: RoomLifecycleState, event: RoomEvent): RoomLifecycleDecision {
    if (state.phase === "closed") return reject(state, "ROOM_CLOSED")
    if (event.generation !== state.generation) return reject(state, "STALE_GENERATION")

    switch (event.type) {
        case "admit": {
            if (state.phase !== "recruiting" && state.phase !== "ready") {
                return reject(state, "ROOM_NOT_JOINABLE")
            }
            if (state.seats.includes(event.identity) || state.joiners[event.identity] !== undefined) {
                return reject(state, "ALREADY_JOINED")
            }
            if (!isJoinable(state)) return reject(state, "ROOM_FULL")
            return {
                state: {
                    ...state,
                    joiners: withJoiner(state.joiners, event.identity, "admitted"),
                },
                effects: [],
            }
        }

        case "handshake": {
            const joinPhase = state.joiners[event.identity]
            if (joinPhase === undefined) {
                // 已占座成员的重连由外壳复用座位；这里只确认房主在线
                if (state.seats.includes(event.identity)) {
                    if (event.identity === state.host && !state.hostOnline) {
                        return {
                            state: { ...state, hostOnline: true },
                            effects: [{ type: "updateShareRow" }],
                        }
                    }
                    return { state, effects: [] }
                }
                return reject(state, "ADMISSION_REQUIRED")
            }
            if (joinPhase === "handshaked" || joinPhase === "entered") {
                return { state, effects: [] }
            }
            return {
                state: {
                    ...state,
                    joiners: withJoiner(state.joiners, event.identity, "handshaked"),
                },
                effects: [],
            }
        }

        case "enter": {
            const isSeat = state.seats.includes(event.identity)
            const joinPhase = state.joiners[event.identity]
            const isHost = event.identity === state.host

            if (state.phase === "closing") {
                if (joinPhase === "handshaked") {
                    return {
                        state: {
                            ...state,
                            joiners: withJoiner(state.joiners, event.identity, "entered"),
                        },
                        effects: [
                            { type: "sendEnterReply", identity: event.identity },
                            { type: "sendDismiss", identity: event.identity },
                        ],
                    }
                }
                if (isSeat || joinPhase === "entered") {
                    return {
                        state,
                        effects: [{ type: "sendEnterReply", identity: event.identity }],
                    }
                }
                return reject(state, "ROOM_CLOSING")
            }

            if (isSeat) {
                const firstHostEntry = isHost && state.phase === "recruiting"
                return {
                    state: {
                        ...state,
                        phase: firstHostEntry ? "ready" : state.phase,
                        hostOnline: isHost ? true : state.hostOnline,
                        hostEntryTimeMs: firstHostEntry ? event.nowMs : state.hostEntryTimeMs,
                    },
                    effects: [
                        { type: "sendEnterReply", identity: event.identity },
                        { type: "broadcastMates" },
                        { type: "updateShareRow" },
                    ],
                }
            }

            if (state.phase !== "recruiting" && state.phase !== "ready") {
                return reject(state, "ROOM_NOT_JOINABLE")
            }
            if (joinPhase === undefined) return reject(state, "ADMISSION_REQUIRED")
            if (joinPhase !== "handshaked") return reject(state, "HANDSHAKE_REQUIRED")
            if (state.seats.length >= capacityOf(state)) return reject(state, "ROOM_FULL")

            return {
                state: {
                    ...state,
                    phase: isHost ? "ready" : state.phase,
                    seats: addIdentity(state.seats, event.identity),
                    joiners: withoutJoiner(state.joiners, event.identity),
                    hostOnline: isHost ? true : state.hostOnline,
                    hostEntryTimeMs: isHost ? event.nowMs : state.hostEntryTimeMs,
                },
                effects: [
                    { type: "sendEnterReply", identity: event.identity },
                    { type: "broadcastMates" },
                    { type: "updateShareRow" },
                ],
            }
        }

        case "ready": {
            if (state.phase !== "recruiting" && state.phase !== "ready") {
                return reject(state, "ROOM_NOT_READY")
            }
            if (!state.seats.includes(event.identity)) return reject(state, "NOT_SEATED")
            return {
                state: {
                    ...state,
                    ready: event.ready
                        ? addIdentity(state.ready, event.identity)
                        : removeIdentity(state.ready, event.identity),
                },
                effects: [],
            }
        }

        case "startBattle": {
            if (event.identity !== state.host) return reject(state, "HOST_ONLY")
            if (state.phase !== "ready") return reject(state, "ROOM_NOT_READY")
            if (state.seats.some(seat => !state.ready.includes(seat))) {
                return reject(state, "NOT_ALL_READY")
            }
            return {
                state: {
                    ...state,
                    phase: "battle",
                    battleParticipants: [...state.seats],
                    battleSessionId: event.battleSessionId,
                    finished: [],
                    battleFinalized: false,
                    finishedAtMs: null,
                },
                effects: [
                    { type: "closeRecruitment" },
                    { type: "broadcastMates" },
                    { type: "updateShareRow" },
                ],
            }
        }

        case "finish": {
            if (state.phase !== "battle") return reject(state, "NOT_IN_BATTLE")
            if (!state.battleParticipants.includes(event.identity)) {
                return reject(state, "NOT_A_PARTICIPANT")
            }
            if (state.finished.includes(event.identity)) return { state, effects: [] }

            const finished = addIdentity(state.finished, event.identity)
            const allFinished = state.battleParticipants.every(item => finished.includes(item))
            if (!allFinished) {
                return { state: { ...state, finished }, effects: [] }
            }

            return {
                state: finalizeBattle(state, finished, event.nowMs),
                effects: [
                    { type: "releaseSeats" },
                    { type: "persistBattleRelease" },
                    { type: "broadcastMates" },
                    { type: "updateShareRow" },
                    { type: "scheduleGc", ms: event.battleDeadlineMs },
                ],
            }
        }

        case "abort": {
            if (state.phase === "battle") {
                if (event.identity === state.host) {
                    return enterClosing(state, event.nowMs, event.closeDeadlineMs)
                }
                if (!state.battleParticipants.includes(event.identity)) {
                    return reject(state, "NOT_A_PARTICIPANT")
                }
                const battleParticipants = removeIdentity(
                    state.battleParticipants,
                    event.identity,
                )
                const finished = removeIdentity(state.finished, event.identity)
                const seats = removeIdentity(state.seats, event.identity)
                const ready = removeIdentity(state.ready, event.identity)
                const allFinished = battleParticipants.length > 0
                    && battleParticipants.every(item => finished.includes(item))
                if (!allFinished) {
                    return {
                        state: {
                            ...state,
                            battleParticipants,
                            finished,
                            seats,
                            ready,
                        },
                        effects: [
                            { type: "broadcastMates" },
                            { type: "updateShareRow" },
                        ],
                    }
                }
                return {
                    state: finalizeBattle(
                        { ...state, battleParticipants },
                        finished,
                        event.nowMs,
                    ),
                    effects: [
                        { type: "releaseSeats" },
                        { type: "persistBattleRelease" },
                        { type: "broadcastMates" },
                        { type: "updateShareRow" },
                        { type: "scheduleGc", ms: event.battleDeadlineMs },
                    ],
                }
            }

            if (state.phase !== "recruiting" && state.phase !== "ready") {
                return reject(state, "INVALID_PHASE")
            }
            if (event.identity === state.host) {
                return enterClosing(state, event.nowMs, event.closeDeadlineMs)
            }
            return {
                state: {
                    ...state,
                    seats: removeIdentity(state.seats, event.identity),
                    ready: removeIdentity(state.ready, event.identity),
                    joiners: withoutJoiner(state.joiners, event.identity),
                },
                effects: [
                    { type: "broadcastMates" },
                    { type: "updateShareRow" },
                ],
            }
        }

        case "hostReturn": {
            if (event.identity !== state.host) return reject(state, "HOST_ONLY")
            if (state.phase !== "battle") return reject(state, "NOT_IN_BATTLE")
            if (!state.battleFinalized) return reject(state, "BATTLE_NOT_FINALIZED")
            return {
                state: {
                    ...state,
                    phase: "ready",
                    seats: [state.host],
                    ready: [],
                    joiners: {},
                    battleParticipants: [],
                    finished: [],
                    battleSessionId: null,
                    battleFinalized: false,
                    finishedAtMs: null,
                    hostOnline: true,
                    hostEntryTimeMs: event.nowMs,
                },
                effects: [
                    { type: "broadcastMates" },
                    { type: "updateShareRow" },
                ],
            }
        }

        case "disband": {
            if (event.identity !== null && event.identity !== state.host) {
                return reject(state, "HOST_ONLY")
            }
            return enterClosing(state, event.nowMs, event.closeDeadlineMs)
        }

        case "socketLost": {
            // state 4 豁免：客户端在战斗中用的是 battle socket，room socket 关闭
            // 不代表房主死亡；结算期的生与死由 battle socket/资源 deadline 兜底。
            if (state.phase === "battle") return { state, effects: [] }
            if (state.phase === "closing") return confirmClosed(state, event.identity)

            if (event.identity === state.host) {
                return {
                    state: { ...state, hostOnline: false },
                    effects: [{ type: "updateShareRow" }],
                }
            }
            if (state.seats.includes(event.identity)) {
                return {
                    state: {
                        ...state,
                        seats: removeIdentity(state.seats, event.identity),
                        ready: removeIdentity(state.ready, event.identity),
                        joiners: withoutJoiner(state.joiners, event.identity),
                    },
                    effects: [
                        { type: "broadcastMates" },
                        { type: "updateShareRow" },
                    ],
                }
            }
            if (state.joiners[event.identity] !== undefined) {
                return {
                    state: {
                        ...state,
                        joiners: withoutJoiner(state.joiners, event.identity),
                    },
                    effects: [],
                }
            }
            return { state, effects: [] }
        }

        case "closeConfirmed": {
            if (state.phase !== "closing") return reject(state, "NOT_CLOSING")
            return confirmClosed(state, event.identity)
        }

        case "gcSweep": {
            if (state.phase === "battle"
                && state.battleFinalized
                && state.finishedAtMs !== null
                && event.nowMs - state.finishedAtMs >= event.battleDeadlineMs) {
                return enterClosing(state, event.nowMs, event.closeDeadlineMs)
            }
            if (state.phase === "closing"
                && state.closingAtMs !== null
                && event.nowMs - state.closingAtMs >= event.closeDeadlineMs) {
                return {
                    state: { ...state, phase: "closed" },
                    effects: [{ type: "closeRoom" }],
                }
            }
            return { state, effects: [] }
        }
    }
}
