import { randomInt } from "crypto";
import { MultiRoom, QuestCategory } from "../types";
import { getServerTime } from "../../utils";
import { sessionManager } from "../state/SessionManager";
import { filterRoomsForList } from "./listing";

const rooms = new Map<string, MultiRoom>();

let roomSequence = 1;

const INCOMPLETE_EXPIRY_MS = parseInt(process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS || "900000"); // 15min, mates < 3
const FULL_ROOM_EXPIRY_MS = parseInt(process.env.MULTI_ROOM_FULL_EXPIRY_MS || "1800000"); // 30min, mates >= 3
const CLEAN_INTERVAL_MS = parseInt(process.env.MULTI_ROOM_CLEAN_INTERVAL_MS || "60000");
const REMAINING_NOTIFY_MS = 30000; // send RemainingTime float 30s before disband

// Track which rooms have already been notified (to avoid repeat floats)
const notifiedRooms = new Set<string>();

function cleanExpiredRooms() {
    const now = Date.now();
    const timeOffset = now - getServerTime() * 1000;
    let cleaned = 0;
    for (const [roomNumber, room] of rooms) {
        // Battle rooms — rely on removeClient auto-disband, no timer
        if (room.raising_state === 4) continue;

        const idleAge = now - (room.host_entry_time * 1000 + timeOffset);
        const timeout = room.mates.length < 3 ? INCOMPLETE_EXPIRY_MS : FULL_ROOM_EXPIRY_MS;
        const remaining = timeout - idleAge;

        // Send RemainingTime float 30s before expiry
        if (remaining > 0 && remaining <= REMAINING_NOTIFY_MS && !notifiedRooms.has(roomNumber)) {
            sessionManager.broadcastToRoom(roomNumber, [1, [7, Math.ceil(remaining / 1000)]])
            notifiedRooms.add(roomNumber)
            console.log(`[MULTI] RemainingTime sent: room=${roomNumber} seconds=${Math.ceil(remaining / 1000)}`)
        }

        if (idleAge > timeout) {
            rooms.delete(roomNumber);
            sessionManager.removeRoomState(roomNumber);
            notifiedRooms.delete(roomNumber);
            cleaned++;
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
        npc_count: 0,
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
    return filterRoomsForList(Array.from(rooms.values()), categoryId, eventId);
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
