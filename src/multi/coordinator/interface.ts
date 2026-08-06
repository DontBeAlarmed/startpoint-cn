import type {
    BattleSessionId,
    CoordinatorResult,
    MultiCompatibilityProfile,
    ParticipantIdentity,
} from "./contracts"

export interface CreateRoomInput {
    readonly requestId: string
    readonly participant: ParticipantIdentity
    /** Node-local only; never use this value as a cross-node or Hub identity. */
    readonly localPlayerId?: number
    readonly partyId: number
    readonly category: number
    readonly questId: number
    readonly leaderCharacterId: number
    readonly compatibility: MultiCompatibilityProfile
}

export type RoomLocator =
    | { readonly roomNumber: string; readonly accessToken?: never }
    | { readonly roomNumber?: never; readonly accessToken: string }

export type CompatibleRoomInput = {
    readonly participant: ParticipantIdentity
    readonly compatibility: MultiCompatibilityProfile
} & RoomLocator

export interface RoomParticipantInput {
    readonly participant: ParticipantIdentity
    readonly roomNumber: string
    /** Hub-internal authorization identity; control routes overwrite client input. */
    readonly credentialId?: string
}

export interface BattleSessionInput extends RoomParticipantInput {
    readonly battleSessionId: BattleSessionId
}

export interface StartBattleInput extends RoomParticipantInput {
    readonly compatibility: MultiCompatibilityProfile
}

export interface RoomStatus {
    readonly roomNumber: string
    readonly accessToken: string
    readonly category: number
    readonly questId: number
    readonly hostEntryTime: number
    readonly roomSequence: number
    readonly raisingState: number
    readonly shareRoomOptions: number
    readonly hostMainCharacterId: number
    readonly isNpcMode: boolean
    readonly hostOnline: boolean
    readonly host: ParticipantIdentity
    readonly members: readonly ParticipantIdentity[]
    readonly compatibility: MultiCompatibilityProfile
    readonly battleSessionId?: BattleSessionId
}

export interface BattleStatus {
    readonly battleSessionId: BattleSessionId
    readonly roomNumber: string
    readonly host: ParticipantIdentity
    readonly participants: readonly ParticipantIdentity[]
    readonly finalized: boolean
}

export interface MultiCoordinator {
    createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>>
    searchRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>>
    prepareRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>>
    selectRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>>
    disbandRoom(input: RoomParticipantInput): Promise<CoordinatorResult<void>>
    abortBattle(input: RoomParticipantInput): Promise<CoordinatorResult<void>>
    startBattle(input: StartBattleInput): Promise<CoordinatorResult<BattleStatus>>
    finalizeBattle(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>>
    getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>>
    getRoomStatus(input: RoomParticipantInput): Promise<CoordinatorResult<RoomStatus>>
}
