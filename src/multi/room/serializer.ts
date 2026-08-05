import * as os from "os"
import { MultiRoom } from "../types"
import type { RoomStatus } from "../coordinator/interface"

export function getDisplayHost(): string {
    const publicHost = (process.env.SESSION_PUBLIC_HOST || process.env.CN_PUBLIC_HOST || "").trim()
    if (publicHost.length > 0) return publicHost

    const raw = (process.env.CN_LISTEN_HOST || "127.0.0.1").trim()
    if (raw !== "0.0.0.0" && raw !== "::") return raw
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
        const addrs = nets[name]
        if (!addrs) continue
        for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
                return addr.address
            }
        }
    }
    return "127.0.0.1"
}

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
    // Fields required by the client's MultiBattleQuestGetRoomsRealRemote parser.
    // establisher_character must be an Int (null crashes the client with ClientError 8700).
    establisher_character: number;
    establisher_character_evolution_img_level: number;
    establisher_follow: number;
    establisher_name: string;
    is_pickup: boolean;
    mates: number;
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

export interface RoomConnectionEndpoint {
    readonly host: string
    readonly port: number
}

export function serializeRoom(room: MultiRoom): SerializedRoom {
    const charId = Number(room.host_main_character_id) || 1;
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
        // Required by client parser (see SerializedRoom).
        establisher_character: charId,
        establisher_character_evolution_img_level: 0,
        establisher_follow: 1,
        establisher_name: `Player${room.host_viewer_id}`,
        is_pickup: false,
        mates: room.mates.length,
    };
}

export function serializeRoomConnection(room: MultiRoom): SerializedRoomConnection {
    return serializeRoomConnectionFields({
        category: room.category,
        hostEntryTime: room.host_entry_time,
        questId: room.quest_id,
        raisingState: room.raising_state,
        roomNumber: room.room_number,
        roomSequence: room.room_sequence,
        shareRoomOptions: room.share_room_options,
    })
}

export function serializeRoomStatusConnection(
    room: RoomStatus,
    endpoint?: RoomConnectionEndpoint | null,
): SerializedRoomConnection {
    return serializeRoomConnectionFields(room, endpoint)
}

function serializeRoomConnectionFields(room: {
    readonly category: number
    readonly hostEntryTime: number
    readonly questId: number
    readonly raisingState: number
    readonly roomNumber: string
    readonly roomSequence: number
    readonly shareRoomOptions: number
}, endpoint?: RoomConnectionEndpoint | null): SerializedRoomConnection {
    const displayHost = endpoint?.host ?? getDisplayHost();
    const sessionPort = endpoint?.port ?? parseInt(process.env.SESSION_PORT || "8003");
    return {
        application_update_url: "",
        category_id: room.category,
        host_entry_time: room.hostEntryTime,
        ip_address: displayHost,
        port: sessionPort,
        quest_id: room.questId,
        raising_state: room.raisingState,
        room_number: room.roomNumber,
        room_sequence: room.roomSequence,
        share_room_options: room.shareRoomOptions,
        is_pickup: null,
    };
}
