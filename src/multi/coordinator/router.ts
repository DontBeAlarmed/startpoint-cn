import type {
    AdmissionIssueInput,
    AdmissionIssueResult,
    AdmissionIssuer,
} from "../admission/registry"
import {
    participantKey,
    type MultiCoordinatorOrigin,
    type ParticipantIdentity,
} from "./contracts"
import type {
    BattleSessionInput,
    BattleStatus,
    CompatibleRoomInput,
    CreateRoomInput,
    MultiCoordinator,
    RoomParticipantInput,
    RoomStatus,
    StartBattleInput,
} from "./interface"
import type { CoordinatorResult } from "./contracts"

type OriginResolver = (
    participant: ParticipantIdentity,
) => MultiCoordinatorOrigin | null | Promise<MultiCoordinatorOrigin | null>

export interface RoutedMultiCoordinatorOptions {
    readonly remote: MultiCoordinator
    readonly local: MultiCoordinator
    readonly remoteAdmissionIssuer: AdmissionIssuer
    readonly localAdmissionIssuer: AdmissionIssuer
    readonly newRoomOrigin: () => MultiCoordinatorOrigin
    readonly resolveActiveQuestOrigin?: OriginResolver
}

export interface CoordinatorOriginLookup {
    readonly participant: ParticipantIdentity
    readonly roomNumber?: string
    readonly accessToken?: string
}

export interface OriginAwareMultiCoordinator {
    resolveOrigin(input: CoordinatorOriginLookup): Promise<MultiCoordinatorOrigin>
    coordinatorFor(origin: MultiCoordinatorOrigin): MultiCoordinator
}

export function isOriginAwareMultiCoordinator(
    coordinator: MultiCoordinator,
): coordinator is MultiCoordinator & OriginAwareMultiCoordinator {
    const candidate = coordinator as Partial<OriginAwareMultiCoordinator>
    return typeof candidate.resolveOrigin === "function"
        && typeof candidate.coordinatorFor === "function"
}

export class RoutedMultiCoordinator implements MultiCoordinator, AdmissionIssuer, OriginAwareMultiCoordinator {
    private readonly roomOrigins = new Map<string, MultiCoordinatorOrigin>()
    private readonly accessTokenOrigins = new Map<string, MultiCoordinatorOrigin>()
    private readonly participantOrigins = new Map<string, MultiCoordinatorOrigin>()

    constructor(private readonly options: RoutedMultiCoordinatorOptions) {}

    coordinatorFor(origin: MultiCoordinatorOrigin): MultiCoordinator {
        return origin === "remote" ? this.options.remote : this.options.local
    }

    async resolveOrigin(input: CoordinatorOriginLookup): Promise<MultiCoordinatorOrigin> {
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        if (activeOrigin === "remote" || activeOrigin === "local") return activeOrigin
        if (input.roomNumber) {
            const roomOrigin = this.roomOrigins.get(input.roomNumber)
            if (roomOrigin) return roomOrigin
        }
        if (input.accessToken) {
            const tokenOrigin = this.accessTokenOrigins.get(input.accessToken)
            if (tokenOrigin) return tokenOrigin
        }
        const participantOrigin = this.participantOrigins.get(this.participantKey(input.participant))
        if (participantOrigin) return participantOrigin
        return this.newRoomOrigin()
    }

    async createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        const origin = activeOrigin ?? this.newRoomOrigin()
        const result = await this.coordinatorFor(origin).createRoom(input)
        if (result.ok) this.remember(origin, input.participant, result.value, true)
        return result
    }

    searchRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.lookupRoom("searchRoom", input, false)
    }

    prepareRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.routeRoomWrite("prepareRoom", input)
    }

    selectRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.lookupRoom("selectRoom", input, true)
    }

    disbandRoom(input: RoomParticipantInput): Promise<CoordinatorResult<void>> {
        return this.routeRoomOperation(input, "disbandRoom")
    }

    abortBattle(input: RoomParticipantInput): Promise<CoordinatorResult<void>> {
        return this.routeRoomOperation(input, "abortBattle")
    }

    async startBattle(input: StartBattleInput): Promise<CoordinatorResult<BattleStatus>> {
        const origin = await this.resolveOrigin(input)
        const result = await this.coordinatorFor(origin).startBattle(input)
        if (result.ok) this.rememberBattle(origin, input.participant, result.value.roomNumber)
        return result
    }

    finalizeBattle(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        return this.routeRoomOperation(input, "finalizeBattle")
    }

    getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        return this.routeRoomOperation(input, "getBattleStatus")
    }

    getRoomStatus(input: RoomParticipantInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.routeRoomOperation(input, "getRoomStatus")
    }

    async issue(input: AdmissionIssueInput): Promise<AdmissionIssueResult> {
        const origin = await this.resolveOrigin(input)
        const issuer = origin === "remote"
            ? this.options.remoteAdmissionIssuer
            : this.options.localAdmissionIssuer
        return issuer.issue(input)
    }

    private async lookupRoom(
        operation: "searchRoom" | "selectRoom",
        input: CompatibleRoomInput,
        rememberParticipant: boolean,
    ): Promise<CoordinatorResult<RoomStatus>> {
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        const cachedOrigin = this.cachedOrigin(input)
        const preferred = activeOrigin ?? cachedOrigin ?? this.newRoomOrigin()
        const first = await this.coordinatorFor(preferred)[operation](input)
        if (first.ok) {
            this.remember(preferred, input.participant, first.value, rememberParticipant)
            return first
        }
        if (activeOrigin || cachedOrigin || first.error !== "ROOM_NOT_FOUND") return first

        const alternate = preferred === "remote" ? "local" : "remote"
        const second = await this.coordinatorFor(alternate)[operation](input)
        if (second.ok) this.remember(alternate, input.participant, second.value, rememberParticipant)
        return second
    }

    private async routeRoomWrite(
        operation: "prepareRoom",
        input: CompatibleRoomInput,
    ): Promise<CoordinatorResult<RoomStatus>> {
        const origin = await this.resolveOrigin(input)
        const result = await this.coordinatorFor(origin)[operation](input)
        if (result.ok) this.remember(origin, input.participant, result.value, true)
        return result
    }

    private async routeRoomOperation<
        TInput extends RoomParticipantInput,
        TOperation extends "disbandRoom" | "abortBattle" | "finalizeBattle" | "getBattleStatus" | "getRoomStatus",
    >(
        input: TInput,
        operation: TOperation,
    ): Promise<Awaited<ReturnType<MultiCoordinator[TOperation]>>> {
        const origin = await this.resolveOrigin(input)
        const coordinator = this.coordinatorFor(origin)
        const result = await coordinator[operation](input as never) as Awaited<ReturnType<MultiCoordinator[TOperation]>>
        if (result.ok && ["disbandRoom", "abortBattle", "finalizeBattle"].includes(operation)) {
            this.roomOrigins.delete(input.roomNumber)
        }
        return result
    }

    private cachedOrigin(input: CoordinatorOriginLookup): MultiCoordinatorOrigin | null {
        if (input.roomNumber) {
            const roomOrigin = this.roomOrigins.get(input.roomNumber)
            if (roomOrigin) return roomOrigin
        }
        if (input.accessToken) {
            const tokenOrigin = this.accessTokenOrigins.get(input.accessToken)
            if (tokenOrigin) return tokenOrigin
        }
        return null
    }

    private remember(
        origin: MultiCoordinatorOrigin,
        participant: ParticipantIdentity,
        room: RoomStatus,
        rememberParticipant: boolean,
    ): void {
        this.roomOrigins.set(room.roomNumber, origin)
        this.accessTokenOrigins.set(room.accessToken, origin)
        if (rememberParticipant) {
            this.participantOrigins.set(this.participantKey(participant), origin)
        }
    }

    private rememberBattle(
        origin: MultiCoordinatorOrigin,
        participant: ParticipantIdentity,
        roomNumber: string,
    ): void {
        this.roomOrigins.set(roomNumber, origin)
        this.participantOrigins.set(this.participantKey(participant), origin)
    }

    private participantKey(participant: ParticipantIdentity): string {
        return participantKey(participant.nodeSessionId, participant.viewerId)
    }

    private newRoomOrigin(): MultiCoordinatorOrigin {
        const origin = this.options.newRoomOrigin()
        if (origin !== "remote" && origin !== "local") {
            throw new TypeError("newRoomOrigin must return remote or local")
        }
        return origin
    }
}
