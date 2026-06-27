import { randomInt } from "crypto";
import { MultiRoom, QuestCategory, RoomState } from "../types";
import { getServerTime } from "../../utils";
import { sessionManager } from "../state/SessionManager";

const rooms = new Map<string, MultiRoom>();

let roomSequence = 1;

const ROOM_EXPIRY_MS = parseInt(process.env.MULTI_ROOM_EXPIRY_MS || "600000");
const BATTLE_ROOM_EXPIRY_MS = parseInt(process.env.MULTI_BATTLE_ROOM_EXPIRY_MS || "600000");
const CLEAN_INTERVAL_MS = parseInt(process.env.MULTI_ROOM_CLEAN_INTERVAL_MS || "60000");

function cleanExpiredRooms() {
    const now = Date.now();
    const timeOffset = now - getServerTime() * 1000;
    let cleaned = 0;
    for (const [roomNumber, room] of rooms) {
        const idleAge = now - (room.host_entry_time * 1000 + timeOffset);
        if (idleAge > ROOM_EXPIRY_MS && room.raising_state <= 3) {
            rooms.delete(roomNumber);
            cleaned++;
            continue;
        }
        if (room.raising_state === 4) {
            const hostEntryAge = now - (room.host_entry_time * 1000 + timeOffset);
            if (hostEntryAge > BATTLE_ROOM_EXPIRY_MS) {
                rooms.delete(roomNumber);
                cleaned++;
            }
        }
    }
    if (cleaned > 0) console.log(`[MULTI] expired rooms cleaned: ${cleaned}`);
}
setInterval(cleanExpiredRooms, CLEAN_INTERVAL_MS);

export const STATIC_ACCESS_TOKEN = "multi_battle_quest_access_token";

export function generateRoomNumber(): string {
    return String(randomInt(100000, 999999));
}

export function createRoom(
    hostViewerId: number,
    hostPlayerId: number,
    hostPartyId: number,
    category: QuestCategory,
    questId: number,
    acceptedType: number,
    hostMainCharacterId: number,
    isNpcMode: boolean = false
): MultiRoom {
    const roomNumber = generateRoomNumber();
    const room: MultiRoom = {
        room_number: roomNumber,
        access_token: STATIC_ACCESS_TOKEN,
        category,
        quest_id: questId,
        host_viewer_id: hostViewerId,
        host_player_id: hostPlayerId,
        host_party_id: hostPartyId,
        host_main_character_id: hostMainCharacterId,
        accepted_type: acceptedType,
        created_at: Date.now(),
        raising_state: 2,
        room_sequence: roomSequence++,
        host_entry_time: getServerTime(),
        mates: [],
        share_room_options: 0,
        is_npc_mode: isNpcMode,
    };
    rooms.set(roomNumber, room);
    console.log(`[MULTI] room created: ${roomNumber} host=${hostViewerId} category=${category} quest=${questId}`);
    return room;
}

export function getRoom(roomNumber: string): MultiRoom | undefined {
    const room = rooms.get(roomNumber);
    if (!room) console.log(`[MULTI] room not found: ${roomNumber}`);
    return room;
}

export function getRoomByToken(token: string): MultiRoom | undefined {
    for (const room of rooms.values()) {
        if (room.access_token === token) return room;
    }
    return undefined;
}

export function getRooms(categoryId: number, eventId?: number): MultiRoom[] {
    const result: MultiRoom[] = [];
    for (const room of rooms.values()) {
        if (room.category === categoryId) {
            result.push(room);
        }
    }
    return result;
}

export function updateRoomState(roomNumber: string, state: number): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    console.log(`[MULTI] room state: ${roomNumber} → ${state}`);
    room.raising_state = state;
    return true;
}

export function setRoomBattle(roomNumber: string): boolean {
    return updateRoomState(roomNumber, 4);
}

export function disbandRoom(roomNumber: string): boolean {
    const deleted = rooms.delete(roomNumber);
    if (deleted) {
        console.log(`[MULTI] room deleted: ${roomNumber}`);
        sessionManager.removeRoomState(roomNumber);
    }
    return deleted;
}

export function updateHostEntryTime(roomNumber: string): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    room.host_entry_time = getServerTime();
    return true;
}
