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

interface RoomOriginEntry {
    readonly generation: number
    readonly origin: MultiCoordinatorOrigin
    readonly roomNumber: string
    readonly accessToken?: string
    readonly participantKey?: string
}

export interface RoutedMultiCoordinatorOptions {
    readonly remote: MultiCoordinator
    readonly local: MultiCoordinator
    readonly remoteAdmissionIssuer: AdmissionIssuer
    readonly localAdmissionIssuer: AdmissionIssuer
    readonly newRoomOrigin: () => MultiCoordinatorOrigin | Promise<MultiCoordinatorOrigin>
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
    private readonly roomOrigins = new Map<string, RoomOriginEntry>()
    private readonly accessTokenOrigins = new Map<string, RoomOriginEntry>()
    private readonly participantOrigins = new Map<string, RoomOriginEntry>()
    private nextGeneration = 0

    constructor(private readonly options: RoutedMultiCoordinatorOptions) {}

    coordinatorFor(origin: MultiCoordinatorOrigin): MultiCoordinator {
        return origin === "remote" ? this.options.remote : this.options.local
    }

    async resolveOrigin(input: CoordinatorOriginLookup): Promise<MultiCoordinatorOrigin> {
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        if (activeOrigin === "remote" || activeOrigin === "local") return activeOrigin
        if (input.roomNumber) {
            const roomOrigin = this.roomOrigins.get(input.roomNumber)
            if (roomOrigin) return roomOrigin.origin
        }
        if (input.accessToken) {
            const tokenOrigin = this.accessTokenOrigins.get(input.accessToken)
            if (tokenOrigin) return tokenOrigin.origin
        }
        const participantOrigin = this.participantOrigins.get(this.participantKey(input.participant))
        if (participantOrigin) return participantOrigin.origin
        return this.newRoomOrigin()
    }

    async createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        const generation = this.nextEntryGeneration()
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        const origin = activeOrigin ?? await this.newRoomOrigin()
        const result = await this.coordinatorFor(origin).createRoom(input)
        if (result.ok) this.remember(origin, input.participant, result.value, true, generation)
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
        const generation = this.nextEntryGeneration()
        const origin = await this.resolveOrigin(input)
        const result = await this.coordinatorFor(origin).startBattle(input)
        if (result.ok) this.rememberBattle(origin, input.participant, result.value.roomNumber, generation)
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
        const generation = this.nextEntryGeneration()
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        const cachedOrigin = this.cachedOrigin(input)
        const preferred = activeOrigin ?? cachedOrigin ?? await this.newRoomOrigin()
        const first = await this.coordinatorFor(preferred)[operation](input)
        if (first.ok) {
            this.remember(preferred, input.participant, first.value, rememberParticipant, generation)
            return first
        }
        if (activeOrigin || cachedOrigin || first.error !== "ROOM_NOT_FOUND") return first

        const alternate = preferred === "remote" ? "local" : "remote"
        const second = await this.coordinatorFor(alternate)[operation](input)
        if (second.ok) this.remember(alternate, input.participant, second.value, rememberParticipant, generation)
        return second
    }

    private async routeRoomWrite(
        operation: "prepareRoom",
        input: CompatibleRoomInput,
    ): Promise<CoordinatorResult<RoomStatus>> {
        const generation = this.nextEntryGeneration()
        const origin = await this.resolveOrigin(input)
        const result = await this.coordinatorFor(origin)[operation](input)
        if (result.ok) this.remember(origin, input.participant, result.value, true, generation)
        return result
    }

    private async routeRoomOperation<
        TInput extends RoomParticipantInput,
        TOperation extends "disbandRoom" | "abortBattle" | "finalizeBattle" | "getBattleStatus" | "getRoomStatus",
    >(
        input: TInput,
        operation: TOperation,
    ): Promise<Awaited<ReturnType<MultiCoordinator[TOperation]>>> {
        const isTeardown = operation === "disbandRoom"
            || operation === "abortBattle"
            || operation === "finalizeBattle"
        const teardownEntry = isTeardown ? this.roomOrigins.get(input.roomNumber) : undefined
        const participantEntry = isTeardown
            ? this.participantOrigins.get(this.participantKey(input.participant))
            : undefined
        const origin = teardownEntry?.origin
            ?? (isTeardown
                ? await this.resolveTeardownOrigin(input, participantEntry)
                : await this.resolveOrigin(input))
        const coordinator = this.coordinatorFor(origin)
        const result = await coordinator[operation](input as never) as Awaited<ReturnType<MultiCoordinator[TOperation]>>
        if (result.ok && isTeardown) {
            this.clearTeardownEntry(teardownEntry)
        }
        return result
    }

    private async resolveTeardownOrigin(
        input: RoomParticipantInput,
        participantEntry: RoomOriginEntry | undefined,
    ): Promise<MultiCoordinatorOrigin> {
        const activeOrigin = await this.options.resolveActiveQuestOrigin?.(input.participant)
        if (activeOrigin === "remote" || activeOrigin === "local") return activeOrigin
        if (participantEntry) return participantEntry.origin
        return this.newRoomOrigin()
    }

    private cachedOrigin(input: CoordinatorOriginLookup): MultiCoordinatorOrigin | null {
        if (input.roomNumber) {
            const roomOrigin = this.roomOrigins.get(input.roomNumber)
            if (roomOrigin) return roomOrigin.origin
        }
        if (input.accessToken) {
            const tokenOrigin = this.accessTokenOrigins.get(input.accessToken)
            if (tokenOrigin) return tokenOrigin.origin
        }
        return null
    }

    private remember(
        origin: MultiCoordinatorOrigin,
        participant: ParticipantIdentity,
        room: RoomStatus,
        rememberParticipant: boolean,
        generation: number,
    ): void {
        const previous = this.roomOrigins.get(room.roomNumber)
        const associatedParticipantKey = rememberParticipant
            ? this.participantKey(participant)
            : previous?.participantKey
                && this.isCurrentEntry(
                    this.participantOrigins.get(previous.participantKey),
                    previous,
                )
                ? previous.participantKey
                : undefined
        this.installEntry({
            generation,
            origin,
            roomNumber: room.roomNumber,
            accessToken: room.accessToken,
            participantKey: associatedParticipantKey,
        })
    }

    private rememberBattle(
        origin: MultiCoordinatorOrigin,
        participant: ParticipantIdentity,
        roomNumber: string,
        generation: number,
    ): void {
        const previous = this.roomOrigins.get(roomNumber)
        this.installEntry({
            generation,
            origin,
            roomNumber,
            accessToken: previous?.accessToken,
            participantKey: this.participantKey(participant),
        })
    }

    private installEntry(entry: RoomOriginEntry): void {
        const previous = this.roomOrigins.get(entry.roomNumber)
        if (previous && previous.generation > entry.generation) return
        if (previous) this.detachEntryAssociations(previous)
        this.roomOrigins.set(entry.roomNumber, entry)
        if (entry.accessToken) {
            const current = this.accessTokenOrigins.get(entry.accessToken)
            if (!current || current.generation <= entry.generation) {
                this.accessTokenOrigins.set(entry.accessToken, entry)
            }
        }
        if (entry.participantKey) {
            const current = this.participantOrigins.get(entry.participantKey)
            if (!current || current.generation <= entry.generation) {
                this.participantOrigins.set(entry.participantKey, entry)
            }
        }
    }

    private detachEntryAssociations(entry: RoomOriginEntry): void {
        if (entry.accessToken && this.isCurrentEntry(this.accessTokenOrigins.get(entry.accessToken), entry)) {
            this.accessTokenOrigins.delete(entry.accessToken)
        }
        if (entry.participantKey && this.isCurrentEntry(this.participantOrigins.get(entry.participantKey), entry)) {
            this.participantOrigins.delete(entry.participantKey)
        }
    }

    private clearTeardownEntry(entry: RoomOriginEntry | undefined): void {
        if (!entry || !this.isCurrentEntry(this.roomOrigins.get(entry.roomNumber), entry)) return
        this.roomOrigins.delete(entry.roomNumber)
        this.detachEntryAssociations(entry)
    }

    private isCurrentEntry(current: RoomOriginEntry | undefined, expected: RoomOriginEntry): boolean {
        return current?.roomNumber === expected.roomNumber
            && current.generation === expected.generation
    }

    private nextEntryGeneration(): number {
        this.nextGeneration += 1
        return this.nextGeneration
    }

    private participantKey(participant: ParticipantIdentity): string {
        return participantKey(participant.nodeSessionId, participant.viewerId)
    }

    private async newRoomOrigin(): Promise<MultiCoordinatorOrigin> {
        const origin = await this.options.newRoomOrigin()
        if (origin !== "remote" && origin !== "local") {
            throw new TypeError("newRoomOrigin must return remote or local")
        }
        return origin
    }
}
