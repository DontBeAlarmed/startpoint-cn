import type {
    AdmissionIssueInput,
    AdmissionIssueResult,
    AdmissionIssuer,
} from "../admission/registry"
import type { HubClient } from "../hub/client"
import type { MultiHubTcpEndpoint } from "../hub/control-routes"
import type {
    BattleSessionInput,
    BattleStatus,
    CompatibleRoomInput,
    CreateRoomInput,
    MultiCoordinator,
    RoomParticipantInput,
    RoomStatus,
} from "./interface"
import type { CoordinatorResult, NodeSessionId } from "./contracts"

export interface RemoteHubClient {
    read<T>(route: string, input: unknown): Promise<CoordinatorResult<T>>
    write<T>(
        route: string,
        input: unknown,
        idempotencyKey?: string,
    ): Promise<CoordinatorResult<T>>
    getTcpEndpoint(): MultiHubTcpEndpoint | null
    getNodeSessionId(): NodeSessionId | null
    isAvailable(): boolean
}

export class RemoteMultiCoordinator implements MultiCoordinator, AdmissionIssuer {
    constructor(private readonly client: RemoteHubClient | HubClient) {}

    createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        const { localPlayerId: _localPlayerId, ...hubInput } = input
        return this.client.write("/v1/multi/rooms/create", hubInput, input.requestId)
    }

    searchRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.client.read("/v1/multi/rooms/search", input)
    }

    prepareRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.client.write("/v1/multi/rooms/prepare", input)
    }

    selectRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.client.read("/v1/multi/rooms/select", input)
    }

    disbandRoom(input: RoomParticipantInput): Promise<CoordinatorResult<void>> {
        return this.client.write("/v1/multi/rooms/disband", input)
    }

    startBattle(input: RoomParticipantInput): Promise<CoordinatorResult<BattleStatus>> {
        return this.client.write("/v1/multi/battles/start", input)
    }

    finalizeBattle(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        return this.client.write("/v1/multi/battles/finalize", input)
    }

    getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        return this.client.read("/v1/multi/battles/status", input)
    }

    getRoomStatus(input: RoomParticipantInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.client.read("/v1/multi/rooms/status", input)
    }

    issue(input: AdmissionIssueInput): Promise<AdmissionIssueResult> {
        return this.client.write("/v1/multi/admissions/issue", input)
    }

    getTcpEndpoint(): MultiHubTcpEndpoint | null {
        return this.client.getTcpEndpoint()
    }

    getNodeSessionId(): NodeSessionId | null {
        return this.client.getNodeSessionId()
    }

    isAvailable(): boolean {
        return this.client.isAvailable()
    }
}
