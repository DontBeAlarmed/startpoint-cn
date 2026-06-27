import { MultiRoom } from "../types";
import { getDisplayHost } from "../../data/multiRoom";
import { sessionManager } from "../state/SessionManager";

export interface SerializedRoom {
    access_token: string;
    category_id: number;
    clear_phase: number;
    host_entry_time: number;
    host_main_character_id: number;
    host_player_id: number;
    host_viewer_id: number;
    is_npc_mode: boolean;
    quest_id: number;
    raising_state: number;
    room_number: string;
    share_room_options: number;
    room_sequence: number;
    room_member_count: number;
}

export interface SerializedRoomConnection {
    application_update_url: string;
    category_id: number;
    host_entry_time: number;
    ip_address: string;
    port: number;
    quest_id: number;
    raising_state: number;
    room_number: string;
    room_sequence: number;
    share_room_options: number;
    is_pickup: boolean | null;
}

export function serializeRoom(room: MultiRoom): SerializedRoom {
    return {
        access_token: room.access_token,
        category_id: room.category,
        clear_phase: 0,
        host_entry_time: room.host_entry_time,
        host_main_character_id: room.host_main_character_id,
        host_player_id: room.host_player_id,
        host_viewer_id: room.host_viewer_id,
        is_npc_mode: room.is_npc_mode,
        quest_id: room.quest_id,
        raising_state: room.raising_state,
        room_number: room.room_number,
        share_room_options: room.share_room_options,
        room_sequence: room.room_sequence,
        room_member_count: room.mates.length,
    };
}

export function serializeRoomConnection(room: MultiRoom): SerializedRoomConnection {
    const displayHost = getDisplayHost();
    const sessionPort = parseInt(process.env.SESSION_PORT || "8003");
    return {
        application_update_url: "",
        category_id: room.category,
        host_entry_time: room.host_entry_time,
        ip_address: displayHost,
        port: sessionPort,
        quest_id: room.quest_id,
        raising_state: room.raising_state,
        room_number: room.room_number,
        room_sequence: room.room_sequence,
        share_room_options: room.share_room_options,
        is_pickup: null,
    };
}
