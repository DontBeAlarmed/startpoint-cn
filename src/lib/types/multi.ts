import { QuestCategory } from "./quest"

export interface MultiMatePartyCharacter {
    id: number
    evolution_level: number
    exp: number
    over_limit_step: number
    mana_node_ids: number[] | null
    ex_boost: {
        ability_id_list: number[]
        status_id: number
    } | null
}


export interface MultiMateEquipment {
    equipment_id: number
    level: number
    enhancement_level: number
}


export interface MultiMateParty {
    characters: (MultiMatePartyCharacter | null)[]
    unison_characters: (MultiMatePartyCharacter | null)[]
    equipments: (MultiMateEquipment | null)[]
    ability_soul_ids: (number | null)[]
}


export interface MultiMate {
    com_id: number
    degree_id: number
    rank: number
    party: MultiMateParty
}


export interface RoomNpcAssignment {
    com_id: 1 | 2
    name: string
}


export interface MultiRoom {
    room_number: string
    access_token: string
    category: QuestCategory
    quest_id: number
    host_viewer_id: number
    host_player_id: number
    host_party_id: number
    host_main_character_id: number
    accepted_type: number
    created_at: number
    raising_state: number
    room_sequence: number
    host_entry_time: number
    member_viewer_ids: number[]
    mates: Array<{ viewer_id: number | null, com_id: number, player_id?: number }>
    share_room_options: number
    is_npc_mode: boolean
    npc_count: number  // fixed NPC count per battle: 0=unrecruited, 1/2=fixed count
    npc_roster: RoomNpcAssignment[]
}


export interface NpcMateTemplate {
    com_id: 1 | 2
    characters: number[]
    unison_characters: number[]
    equipments: number[]
    ability_soul_ids: number[]
    rank: number
    degree_id: number
}
