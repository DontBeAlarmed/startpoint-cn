// === Re-export from lib/types.ts (backward compatible) ===
export type {
    MultiMatePartyCharacter,
    MultiMateEquipment,
    MultiMateParty,
    MultiMate,
    MultiRoom,
    NpcMateTemplate,
    RoomNpcAssignment,
    QuestCategory,
} from "../lib/types"

// === HTTP request body types (extracted from multiBattleQuest.ts) ===
export interface GetRoomsBody {
    event_id?: number
    viewer_id: number
    category_id: number
}

export interface CreateRoomBody {
    category: number
    party_id: number
    quest_id: number
    viewer_id: number
    api_count: number
}

export interface SearchRoomBody {
    room_number: string
    viewer_id: number
    api_count: number
}

export interface SelectRoomBody {
    category: number
    quest_id: number
    party_id: number
    accepted_type: number
    viewer_id: number
    room_number?: string
    access_token?: string
    api_count: number
}

export interface PrepareBody {
    category: number
    quest_id: number
    viewer_id: number
    room_number?: string
    access_token?: string
    api_count: number
}

export interface SummonBody {
    category_id: number
    quest_id: number
    room_number: string
    viewer_id: number
    api_count: number
}

export interface MultiStartMateCharacter {
    id: number
    evolution_level: number
    exp: number
    over_limit_step?: number
}

export interface MultiStartMateParty {
    party_id: number
    characters: MultiStartMateCharacter[]
    unison_characters?: MultiStartMateCharacter[]
    equipments: Array<{ equipment_id: number; level: number; enhancement_level: number }>
    ability_soul_ids?: (number | null)[]
}

export interface MultiStartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
    room_number: string
    mate_player_ids: number[]
    mate_party_ids: MultiStartMateParty[]
    attention_key?: string
    combat_power: number
    client_battle_party?: object
    auto_start_times?: number
}

export interface QuestStatisticsParty {
    unison_characters: ({ id: (number | null) } | null)[]
    characters: ({ id: (number | null) } | null)[]
    equipments: ({ id: (number | null) } | null)[]
    ability_soul_ids: (number | null)[]
}

export interface QuestStatistics {
    clear_phase: number
    party: QuestStatisticsParty
    zones?: {
        skill_point_over_on_start?: number
    }[]
}

export interface MultiFinishBody {
    viewer_id: number
    quest_id: number
    category: number
    room_number: string
    clear_phase: number
    quest_statistics: QuestStatistics
    play_id: string
    battle_time: number
    battle_ended_at: number
    api_count: number
    mate_player_ids: number[]
    mate_com_ids: number[]
    is_auto_start_mode: boolean
    combat_power: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
}

export interface MultiAbortBody {
    viewer_id: number
    quest_id: number
    category: number
    room_number: string
    play_id: string
    api_count: number
}

export interface PlayContinueBody {
    viewer_id: number
    quest_id: number
    category: number
    room_number: string
    play_id: string
    api_count: number
}

export interface RestoreRoomBody {
    viewer_id: number
    room_number: string
    api_count: number
}

export interface ShareRoomBody {
    viewer_id: number
    room_number: string
    api_count: number
}

export interface VerifyAccessTokenBody {
    access_token: string
    viewer_id: number
    api_count: number
}

export interface MicroCommunityBody {
    viewer_id: number
    room_number: string
    api_count: number
}

// === Summon response ===
export interface SummonResponse {
    mate1: import("../lib/types").MultiMate | null
    mate2: import("../lib/types").MultiMate | null
}

// === State machine enums ===
export enum RoomState {
    Waiting = 0,
    Ready = 1,
    Filled = 2,
    Battle = 3,
    Disbanded = 4,
}

export enum ClientState {
    Connecting = 0,
    Handshaking = 1,
    InLobby = 2,
    InBattle = 3,
    Disconnected = 4,
}

export enum BattleState {
    Initializing = 0,
    Fighting = 1,
    Finished = 2,
    Aborted = 3,
}

// === Result type for unified error handling ===
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// === MateProvider interface (NPC / real-person coexistence) ===
export interface CompanionInfo {
    viewer_id: number
    player_id: number
    name: string
    rank: number
    main_character_id: number
}

export interface RecruitResult {
    recruitedMates: Array<{ viewer_id: number; com_id: number; player_id?: number }>
}

export interface IRoomMateProvider {
    getMates(roomNumber: string): import("../lib/types").MultiMate[]
    onRecruit(roomNumber: string, hostViewerId: string): Promise<RecruitResult>
    isRoomFull(roomNumber: string): boolean
    getAvailableCompanions(hostViewerId: string): CompanionInfo[]
}
