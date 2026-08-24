import { randomBytes, randomInt } from "crypto";
import { MultiRoom, QuestCategory, RoomState } from "../types";
import { getServerTime } from "../../utils";
import { sessionManager } from "../state/SessionManager";
import type { ParticipantIdentity } from "../coordinator/contracts";

const rooms = new Map<string, MultiRoom>();

let roomSequence = 1;

const DEFAULT_INCOMPLETE_EXPIRY_MS = 900_000; // 15min, mates < 3
const DEFAULT_FULL_ROOM_EXPIRY_MS = 1_800_000; // 30min, mates >= 3
const DEFAULT_CLEAN_INTERVAL_MS = 60_000;
const REMAINING_NOTIFY_MS = 30000; // send RemainingTime float 30s before disband
const ROOM_NUMBER_ALLOCATION_ATTEMPTS = 10;

// Track which rooms have already been notified (to avoid repeat floats)
const notifiedRooms = new Set<string>();

type RoomCleanupTimer = ReturnType<typeof setInterval>;

export interface RoomCleanupOptions {
    incompleteExpiryMs?: number;
    fullExpiryMs?: number;
    intervalMs?: number;
    reconnectGraceMs?: number;
    createInterval?: (callback: () => void, intervalMs: number) => RoomCleanupTimer;
    clearInterval?: (timer: RoomCleanupTimer) => void;
}

export interface RoomCleanupStatus {
    readonly running: boolean;
}

let cleanupTimer: RoomCleanupTimer | null = null;
let clearCleanupInterval: ((timer: RoomCleanupTimer) => void) | null = null;

interface RoomCleanupTiming {
    readonly incompleteExpiryMs: number;
    readonly fullExpiryMs: number;
}

function cleanExpiredRooms(timing: RoomCleanupTiming) {
    const now = Date.now();
    const timeOffset = now - getServerTime() * 1000;
    let cleaned = 0;
    for (const [roomNumber, room] of rooms) {
        // Battle rooms — rely on removeClient auto-disband, no timer
        if (room.raising_state === 4) continue;

        const idleAge = now - (room.host_entry_time * 1000 + timeOffset);
        const timeout = room.mates.length < 3
            ? timing.incompleteExpiryMs
            : timing.fullExpiryMs;
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

export function startRoomCleanup(options: RoomCleanupOptions = {}): void {
    if (cleanupTimer) return;

    const createInterval = options.createInterval ?? setInterval;
    const clearIntervalHandle = options.clearInterval ?? clearInterval;
    const timing: RoomCleanupTiming = Object.freeze({
        incompleteExpiryMs: options.incompleteExpiryMs ?? DEFAULT_INCOMPLETE_EXPIRY_MS,
        fullExpiryMs: options.fullExpiryMs ?? DEFAULT_FULL_ROOM_EXPIRY_MS,
    });
    const timer = createInterval(
        () => cleanExpiredRooms(timing),
        options.intervalMs ?? DEFAULT_CLEAN_INTERVAL_MS,
    );
    try {
        timer.unref();
    } catch (error) {
        clearIntervalHandle(timer);
        throw error;
    }
    cleanupTimer = timer;
    clearCleanupInterval = clearIntervalHandle;
}

export function stopRoomCleanup(): void {
    if (!cleanupTimer) return;
    const timer = cleanupTimer;
    const clearIntervalHandle = clearCleanupInterval ?? clearInterval;
    cleanupTimer = null;
    clearCleanupInterval = null;
    clearIntervalHandle(timer);
}

export function getRoomCleanupStatus(): RoomCleanupStatus {
    return Object.freeze({ running: cleanupTimer !== null });
}

export function generateRoomNumber(): string {
    return String(randomInt(100000, 999999));
}

function allocateRoomNumber(): string {
    for (let attempt = 0; attempt < ROOM_NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
        const roomNumber = generateRoomNumber();
        if (!rooms.has(roomNumber)) return roomNumber;
    }
    throw new Error(
        `failed to allocate an unused room number after ${ROOM_NUMBER_ALLOCATION_ATTEMPTS} attempts`,
    );
}

export function generateRoomAccessToken(): string {
    let token: string;
    do {
        token = randomBytes(24).toString("base64url");
    } while (getRoomByToken(token));
    return token;
}

export function createRoom(
    hostViewerId: number,
    hostPlayerId: number,
    hostPartyId: number,
    category: QuestCategory,
    questId: number,
    acceptedType: number,
    hostMainCharacterId: number,
    isNpcMode: boolean = false,
    hostParticipant: ParticipantIdentity = {
        nodeSessionId: "embedded" as ParticipantIdentity["nodeSessionId"],
        viewerId: hostViewerId,
    },
): MultiRoom {
    if (hostParticipant.viewerId !== hostViewerId) {
        throw new TypeError("host participant viewer must match room host")
    }
    const roomNumber = allocateRoomNumber();
    const room: MultiRoom = {
        room_number: roomNumber,
        access_token: generateRoomAccessToken(),
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
        member_participants: [{ ...hostParticipant }],
        mates: [],
        share_room_options: 0,
        is_npc_mode: isNpcMode,
        npc_count: 0,
        npc_roster: [],
    };
    rooms.set(roomNumber, room);
    console.log(`[MULTI] room created: room=${roomNumber} category=${category} quest=${questId}`);
    return room;
}

export function getRoom(roomNumber: string): MultiRoom | undefined {
    const room = rooms.get(roomNumber);
    if (!room) console.log("[MULTI] room lookup missed");
    return room;
}

export function getRoomOccupiedMemberCount(roomNumber: string): number {
    const room = rooms.get(roomNumber)
    if (!room) return 0
    return new Set(room.member_participants.map(member => member.viewerId)).size
}

export function listActiveRooms(): readonly MultiRoom[] {
    return Object.freeze([...rooms.values()]);
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

export function isRoomViewerMember(room: MultiRoom, viewerId: number): boolean {
    return room.member_participants.some(member => member.viewerId === viewerId);
}

export function isRoomMember(room: MultiRoom, participant: ParticipantIdentity): boolean {
    return room.member_participants.some(member => (
        member.viewerId === participant.viewerId
        && member.nodeSessionId === participant.nodeSessionId
    ));
}

export function hasRoomMemberViewerConflict(
    room: MultiRoom,
    participant: ParticipantIdentity,
): boolean {
    return room.member_participants.some(member => (
        member.viewerId === participant.viewerId
        && member.nodeSessionId !== participant.nodeSessionId
    ));
}

export function addRoomMember(roomNumber: string, participant: ParticipantIdentity): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    if (hasRoomMemberViewerConflict(room, participant)) return false;
    if (!isRoomMember(room, participant)) {
        room.member_participants.push({ ...participant });
    }
    return true;
}

export function removeRoomMember(roomNumber: string, participant: ParticipantIdentity): boolean {
    const room = rooms.get(roomNumber);
    if (!room || participant.viewerId === room.host_viewer_id) return false;
    const index = room.member_participants.findIndex(member => (
        member.viewerId === participant.viewerId
        && member.nodeSessionId === participant.nodeSessionId
    ));
    if (index < 0) return false;
    room.member_participants.splice(index, 1);
    return true;
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
