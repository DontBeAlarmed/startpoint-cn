import { randomInt } from "crypto";
import * as os from "os";
import { MultiRoom, MultiMate, MultiMateParty, MultiMatePartyCharacter, MultiMateEquipment, NpcMateTemplate, QuestCategory } from "../lib/types";
import { getServerTime } from "../utils";

/** Resolve display host for TCP session. If CN_LISTEN_HOST is 0.0.0.0, auto-detect LAN IP. */
export function getDisplayHost(): string {
    const raw = process.env.CN_LISTEN_HOST || "127.0.0.1";
    if (raw !== "0.0.0.0") return raw;
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        const addrs = nets[name];
        if (!addrs) continue;
        for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
                return addr.address;
            }
        }
    }
    return "127.0.0.1";
}

// In-memory room storage (rooms are transient, no DB persistence)
const rooms = new Map<string, MultiRoom>();

// Global room sequence counter
let roomSequence = 1;

// Room expiry time: 10 minutes of inactivity
const ROOM_EXPIRY_MS = 10 * 60 * 1000;

// Clean up expired rooms periodically
function cleanExpiredRooms() {
    const now = Date.now();
    let cleaned = 0;
    for (const [roomNumber, room] of rooms) {
        if (now - room.created_at > ROOM_EXPIRY_MS && room.raising_state <= 2) {
            rooms.delete(roomNumber);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[MULTI] expired rooms cleaned: ${cleaned}`);
}
setInterval(cleanExpiredRooms, 60_000);

// Static access token (not used for auth in private server)
const STATIC_ACCESS_TOKEN = "multi_access_token";

// Generate a 6-digit room number
export function generateRoomNumber(): string {
    return String(randomInt(100000, 999999));
}

// Generate a unique room sequence
export function nextRoomSequence(): number {
    return roomSequence++;
}

// NPC character templates
const NPC_TEMPLATES: Record<string, NpcMateTemplate> = {
    "default_1": {
        com_id: 1,
        characters: [131012, 141007, 151001],
        unison_characters: [141005, 121002, 131004],
        equipments: [200005, 1010001, 2020001],
        ability_soul_ids: [],
        rank: 80,
        degree_id: 1
    },
    "default_2": {
        com_id: 2,
        characters: [141004, 121002, 161001],
        unison_characters: [151001, 141005, 131004],
        equipments: [200005, 1010001, 2020001],
        ability_soul_ids: [],
        rank: 80,
        degree_id: 2000
    }
};

// Build a single NPC mate party from template
function buildNpcMate(template: NpcMateTemplate): MultiMate {
    const characters: (MultiMatePartyCharacter | null)[] = template.characters.map(id => ({
        id,
        evolution_level: 0,
        exp: 0,
        over_limit_step: 0,
        mana_node_ids: null,
        ex_boost: null
    }));

    const unisonCharacters: (MultiMatePartyCharacter | null)[] = template.unison_characters.map(id => ({
        id,
        evolution_level: 0,
        exp: 0,
        over_limit_step: 0,
        mana_node_ids: null,
        ex_boost: null
    }));

    const equipments: (MultiMateEquipment | null)[] = template.equipments.map(equipment_id => ({
        equipment_id,
        level: 1,
        enhancement_level: 0
    }));

    const abilitySoulIds: (number | null)[] = template.ability_soul_ids.map(() => null);
    if (abilitySoulIds.length === 0) {
        abilitySoulIds.push(null, null, null);
    }

    return {
        com_id: template.com_id,
        degree_id: template.degree_id,
        rank: template.rank,
        party: {
            characters,
            unison_characters: unisonCharacters,
            equipments,
            ability_soul_ids: abilitySoulIds
        }
    };
}

// Get NPC mates for a quest (returns 2 mates)
export function getNpcMates(questId: number, category: QuestCategory): { mate1: MultiMate | null, mate2: MultiMate | null } {
    const mate1 = buildNpcMate(NPC_TEMPLATES["default_1"]);
    const mate2 = buildNpcMate(NPC_TEMPLATES["default_2"]);
    console.log(`[MULTI] npc mates: quest=${questId} m1=${mate1?.com_id} m2=${mate2?.com_id}`);
    return { mate1, mate2 };
}

// Create a new room
export function createRoom(
    hostViewerId: number,
    hostPlayerId: number,
    hostPartyId: number,
    category: QuestCategory,
    questId: number,
    acceptedType: number,
    hostMainCharacterId: number
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
        raising_state: 1, // Ready
        room_sequence: nextRoomSequence(),
        host_entry_time: getServerTime(),
        mates: [
            { viewer_id: null, com_id: 1 },
            { viewer_id: null, com_id: 2 }
        ],
        share_room_options: 0
    };
    rooms.set(roomNumber, room);
    console.log(`[MULTI] room created: ${roomNumber} host=${hostViewerId} category=${category} quest=${questId}`);
    return room;
}

// Get room by room number
export function getRoom(roomNumber: string): MultiRoom | undefined {
    const room = rooms.get(roomNumber);
    if (!room) console.log(`[MULTI] room not found: ${roomNumber}`);
    return room;
}

// Get room by access token
export function getRoomByToken(token: string): MultiRoom | undefined {
    for (const room of rooms.values()) {
        if (room.access_token === token) return room;
    }
    return undefined;
}

// Get rooms for a category (and optional event_id)
export function getRooms(categoryId: number, eventId?: number): MultiRoom[] {
    const result: MultiRoom[] = [];
    for (const room of rooms.values()) {
        if (room.category === categoryId) {
            result.push(room);
        }
    }
    return result;
}

// Update room raising state
export function updateRoomState(roomNumber: string, state: number): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    console.log(`[MULTI] room state: ${roomNumber} → ${state}`);
    room.raising_state = state;
    return true;
}

// Set room to battle state
export function setRoomBattle(roomNumber: string): boolean {
    return updateRoomState(roomNumber, 4);
}

// Disband/delete a room
export function disbandRoom(roomNumber: string): boolean {
    const deleted = rooms.delete(roomNumber);
    if (deleted) console.log(`[MULTI] room deleted: ${roomNumber}`);
    return deleted;
}

// Update room host entry time
export function updateHostEntryTime(roomNumber: string): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    room.host_entry_time = getServerTime();
    return true;
}

// Build room data for get_rooms response
export function serializeRoom(room: MultiRoom): Record<string, any> {
    return {
        category_id: room.category,
        quest_id: room.quest_id,
        room_number: room.room_number,
        estabilisher_character: room.host_main_character_id,
        estabilisher_character_evolution_img_level: 0,
        estabilisher_follow: 1,
        estabilisher_name: `Player${room.host_viewer_id}`,
        host_entry_time: room.host_entry_time,
        is_pickup: false,
        mates: room.mates.length,
        raising_state: room.raising_state
    };
}

// Build select_room/prepare response data
export function serializeRoomConnection(room: MultiRoom): Record<string, any> {
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
        is_pickup: null
    };
}
