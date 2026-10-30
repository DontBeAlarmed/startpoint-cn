import { randomBytes, randomInt } from "crypto";
import { describeError } from "../describe-error";
import { MultiRoom, QuestCategory, RoomState } from "../types";
import { getRealNowMs } from "../../runtime/time/game-time";
import { sessionManager } from "../state/SessionManager";
import { identityOf, LIFECYCLE_BATTLE_DEADLINE_MS, LIFECYCLE_CLOSE_DEADLINE_MS, lifecycleRegistry } from "../lifecycle";
import { sampleLifecycleDrift } from "../lifecycle/drift-monitor";
import type { ParticipantIdentity } from "../coordinator/contracts";

const rooms = new Map<string, MultiRoom>();

let roomSequence = 1;

const DEFAULT_INCOMPLETE_EXPIRY_MS = 900_000; // 15min, mates < 3
const DEFAULT_FULL_ROOM_EXPIRY_MS = 1_800_000; // 30min, mates >= 3
// A battle room whose members all vanished without finish/abort keeps its
// battle facts until this bounded grace passes; members that only lag behind
// their HTTP finish stay covered by the same order of magnitude as the idle
// policies above.
const DEFAULT_ABANDONED_BATTLE_EXPIRY_MS = 900_000; // 15min
const DEFAULT_CLEAN_INTERVAL_MS = 60_000;
const REMAINING_NOTIFY_MS = 30000; // send RemainingTime float 30s before disband
/** state 4 未 finalize 的硬上界（只回收，推导状态）；防常连 socket 把战局钉死。 */
const BATTLE_HARD_LIMIT_MS = 2 * 60 * 60_000;
const ROOM_NUMBER_ALLOCATION_ATTEMPTS = 10;
/** closing 超过该年龄先打预警（不强制关闭），用于发现拆除/确认异常。 */
const CLOSING_WARN_MS = 30_000;

// Track which rooms have already been notified (to avoid repeat floats)
const notifiedRooms = new Set<string>();
const warnedClosingRooms = new Set<string>();
let sweptClosingTotal = 0;
let lastSweptClosingAtMs: number | null = null;

export interface RoomCleanupDiagnostics {
    readonly closingRooms: number;
    readonly closingOldestAgeMs: number;
    readonly sweptClosing: number;
    readonly lastSweptClosingAtMs: number | null;
}

type RoomCleanupTimer = ReturnType<typeof setInterval>;

export interface RoomCleanupOptions {
    incompleteExpiryMs?: number;
    fullExpiryMs?: number;
    intervalMs?: number;
    battleHardLimitMs?: number;
    createInterval?: (callback: () => void, intervalMs: number) => RoomCleanupTimer;
    clearInterval?: (timer: RoomCleanupTimer) => void;
    abandonedBattleExpiryMs?: number;
}

export interface RoomCleanupStatus {
    readonly running: boolean;
}

let cleanupTimer: RoomCleanupTimer | null = null;
let clearCleanupInterval: ((timer: RoomCleanupTimer) => void) | null = null;
let roomDisbandListener:
    | ((roomNumber: string, hostPlayerId: number, hostViewerId: number) => void)
    | null = null;

interface RoomCleanupTiming {
    readonly incompleteExpiryMs: number;
    readonly fullExpiryMs: number;
    readonly abandonedBattleExpiryMs: number;
    readonly battleHardLimitMs: number;
}

function notifyRoomDisbanded(roomNumber: string, hostPlayerId: number, hostViewerId: number): void {
    roomDisbandListener?.(roomNumber, hostPlayerId, hostViewerId);
}

function cleanExpiredRooms(timing: RoomCleanupTiming) {
    const now = getRealNowMs();
    // 切片 0：漂移观测（行为不变）——每轮清理 tick 顺带采样五项不变量，
    // 计数/样本经 server/status 暴露；不派生状态、不触发清理。
    sampleLifecycleDrift(now, {
        rooms: [...rooms.values()],
        viewerRoomClientDuplicates: sessionManager.getRoomClientDuplicateViewerStats(),
    });
    // R-15=B：房间老化锚真实时间。host_entry_time 写入点（createRoom/
    // updateHostEntryTime）同步改为 getRealNowMs()，偏移换算删除——
    // timeOffset 调整不得使存量房间瞬时全灭或永不过期。
    // 旧值（虚拟秒）与新值（真实毫秒）混存窗口内可能出现一次瞬态误判，可接受。
    const timeOffset = 0;
    // detached closing 的资源回收：没有 socket 可等的条目按 closeDeadline 清掉。
    // 先对长期未确认的 closing 打一次预警，再执行真正的回收；两者都不改房间状态。
    for (const entry of lifecycleRegistry.closingEntries(now)) {
        if (entry.ageMs < CLOSING_WARN_MS || warnedClosingRooms.has(entry.roomNumber)) continue;
        warnedClosingRooms.add(entry.roomNumber);
        console.warn(
            `[MULTI] closing still pending: room=${entry.roomNumber}`
            + ` ageMs=${entry.ageMs} pending=${entry.pendingIdentities.length}`,
        );
    }
    const swept = lifecycleRegistry.sweepClosing(now, LIFECYCLE_CLOSE_DEADLINE_MS);
    if (swept > 0) {
        sweptClosingTotal += swept;
        lastSweptClosingAtMs = now;
        console.warn(`[MULTI] closing swept: count=${swept}`);
    }
    const stillClosing = new Set(
        lifecycleRegistry.closingEntries(now).map(entry => entry.roomNumber),
    );
    for (const roomNumber of warnedClosingRooms) {
        if (!stillClosing.has(roomNumber)) warnedClosingRooms.delete(roomNumber);
    }
    let cleaned = 0;
    for (const [roomNumber, room] of rooms) {
        // B2b：自检内核的资源 deadline（结算后 15 分钟 / closing 后 5 分钟）。
        // 影子阶段只记录；B3 起由外壳执行 closeRoom/dismiss 效果。
        const lifecycleDecision = lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "gcSweep",
            generation,
            nowMs: now,
            battleDeadlineMs: LIFECYCLE_BATTLE_DEADLINE_MS,
            closeDeadlineMs: LIFECYCLE_CLOSE_DEADLINE_MS,
        }));
        if (lifecycleDecision?.state.phase === "closing") {
            // 内核判定的 state 4 资源上界（结算后 15 分钟）：即使还有 socket
            // 挂着也回收，避免 finalized 房间被常连 socket 钉死。
            if (disbandRoom(roomNumber)) cleaned++;
            continue;
        }
        if (room.raising_state === 4) {
            // 已 Finalize 的战局交给 15 分钟 gcSweep；2 小时硬上界只兜住
            // "从未结算"的常连战局（否则长战局刚结束就会被硬上界强拆）。
            const battleFinalized = lifecycleDecision?.state.phase === "battle"
                && lifecycleDecision.state.battleFinalized === true;
            const startedAt = room.battle_started_at_ms
                ?? room.host_entry_time * 1000;
            const battleAge = startedAt > 0 ? now - startedAt : 0;
            if (!battleFinalized && battleAge > timing.battleHardLimitMs) {
                console.log(`[MULTI] recycling over-age battle room: ${roomNumber}`);
                if (disbandRoom(roomNumber)) cleaned++;
                continue;
            }
            // A battle room is only recycled once every participant is gone
            // (no lobby socket, no battle socket) and the bounded grace has
            // passed; disbandRoom releases the battle facts idempotently.
            if (sessionManager.hasRoomClients(roomNumber)
                || sessionManager.hasBattleClients(roomNumber)) {
                room.battle_empty_since_ms = undefined;
                continue;
            }
            room.battle_empty_since_ms ??= now;
            if (now - room.battle_empty_since_ms > timing.abandonedBattleExpiryMs) {
                console.log(`[MULTI] recycling abandoned battle room: ${roomNumber}`);
                if (disbandRoom(roomNumber)) cleaned++;
            }
            continue;
        }

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
            if (disbandRoom(roomNumber)) cleaned++;
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
        abandonedBattleExpiryMs: options.abandonedBattleExpiryMs
            ?? DEFAULT_ABANDONED_BATTLE_EXPIRY_MS,
        battleHardLimitMs: options.battleHardLimitMs ?? BATTLE_HARD_LIMIT_MS,
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

export function setRoomDisbandListener(
    listener: ((roomNumber: string, hostPlayerId: number, hostViewerId: number) => void) | null,
): void {
    roomDisbandListener = listener;
}

export function getRoomCleanupStatus(): RoomCleanupStatus {
    return Object.freeze({ running: cleanupTimer !== null });
}

export function getRoomCleanupDiagnostics(): RoomCleanupDiagnostics {
    const entries = lifecycleRegistry.closingEntries(getRealNowMs());
    return Object.freeze({
        closingRooms: entries.length,
        closingOldestAgeMs: entries.reduce((max, entry) => Math.max(max, entry.ageMs), 0),
        sweptClosing: sweptClosingTotal,
        lastSweptClosingAtMs,
    });
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
        created_at: getRealNowMs(),
        raising_state: 2,
        room_sequence: roomSequence++,
        // R-15=B：入场时刻锚真实时间（见 cleanExpiredRooms 注释）
        host_entry_time: Math.floor(getRealNowMs() / 1000),
        member_participants: [{ ...hostParticipant }],
        battle_participants: [],
        mates: [],
        share_room_options: 0,
        is_npc_mode: isNpcMode,
        npc_count: 0,
        npc_roster: [],
    };
    sessionManager.initRoomState(roomNumber, RoomState.Filled)
    rooms.set(roomNumber, room);
    // B2a 影子：内核记录生命周期；B3 起成为权威。
    lifecycleRegistry.create(roomNumber, identityOf(hostParticipant))
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

// Wire raising_state numbers onto the RoomStateMachine lifecycle:
// 2 (recruiting, room created with the host) → Filled, 1 (preparation after
// host Enter) → Ready, 4 → Battle. StartBattle is legal from both Filled and
// Ready; Battle → Ready stays legal for the post-battle rematch re-entry.
// The room owner persists only these values; 3/7/9/13 are HTTP response
// projections for the CN client parser and must never become room states.
export type PersistentRaisingState = 1 | 2 | 4

function isPersistentRaisingState(value: unknown): value is PersistentRaisingState {
    return value === 1 || value === 2 || value === 4
}

const RAISING_STATE_TO_ROOM_STATE: ReadonlyMap<PersistentRaisingState, RoomState> = new Map([
    [2, RoomState.Filled],
    [1, RoomState.Ready],
    [4, RoomState.Battle],
])

export function updateRoomState(
    roomNumber: string,
    state: PersistentRaisingState,
): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    if (!isPersistentRaisingState(state)) {
        console.warn(`[MULTI] room state rejected: ${roomNumber} ${String(state)}`);
        return false;
    }
    const machine = sessionManager.getRoomState(roomNumber)
    const target = RAISING_STATE_TO_ROOM_STATE.get(state)
    if (target === undefined) return false;
    if (machine.getState() !== target) {
        const transition = machine.tryTransition(target)
        if (!transition.allowed) {
            console.warn(`[MULTI] room state transition rejected: ${roomNumber} ${transition.reason}`);
            return false;
        }
    }
    const previousState = room.raising_state;
    console.log(`[MULTI] room state: ${roomNumber} → ${state}`);
    room.raising_state = state;
    if (previousState !== 4 && state === 4) room.battle_started_at_ms = getRealNowMs();
    // R-6（官服语义，2026-10-30 维护者裁定）：战斗结算释放全部非房主座位——
    // 房间回到"仅房主+空位"，成员返回与外部加入走同一条普通加入流程竞争
    // 空位（先到先得，成员无优先权）。NPC 名册由 onBattleReleased 钩子清空。
    if (previousState === 4 && state === 1) {
        room.member_participants = room.member_participants.filter(
            member => member.viewerId === room.host_viewer_id,
        );
        // 房间寿命从结算重新起算（战斗时长不计入老化窗口）
        updateHostEntryTime(roomNumber);
    }
    // 好友房间大厅注册行同步（未开放列表可见的房无行，no-op）
    try {
        const { syncRoomShareRow } = require("./share-sync") as typeof import("./share-sync")
        syncRoomShareRow(roomNumber)
    } catch (error) {
        console.warn(`[MULTI] room share sync failed: ${roomNumber}`, describeError(error))
    }
    return true;
}

export function setRoomBattle(roomNumber: string): boolean {
    return updateRoomState(roomNumber, 4);
}

export function reconcileHostReturn(roomNumber: string): boolean {
    const room = rooms.get(roomNumber);
    if (!room || room.raising_state !== 4) return false;
    const lifecycle = lifecycleRegistry.get(roomNumber);
    if (!lifecycle || lifecycle.phase !== "ready") return false;
    // 外壳事实是主判据：battle facts 未释放时绝不 4→1（内核相位只做旁证）。
    if (sessionManager.getActiveBattleSessionId(roomNumber) !== null) return false;
    if (!updateRoomState(roomNumber, 1)) return false;
    room.battle_participants = [];
    room.mates = [{ viewer_id: room.host_viewer_id, com_id: 0 }];
    updateHostEntryTime(roomNumber);
    try {
        const { syncRoomShareRow } = require("./share-sync") as typeof import("./share-sync");
        syncRoomShareRow(roomNumber);
    } catch (error) {
        console.warn(`[MULTI] host return share sync failed: ${roomNumber}`, describeError(error));
    }
    return true;
}

function settleDisbandedIdentities(
    roomNumber: string,
    lifecycle: ReturnType<typeof lifecycleRegistry.get>,
    liveIdentities: ReadonlySet<string>,
): void {
    if (!lifecycle) return;
    if (lifecycle.phase === "closed") {
        lifecycleRegistry.remove(roomNumber);
        return;
    }
    const known = new Set<string>([
        ...lifecycle.seats,
        ...lifecycle.battleParticipants,
        ...Object.keys(lifecycle.joiners),
    ]);
    if (known.size === 0) {
        lifecycleRegistry.remove(roomNumber);
        return;
    }
    for (const identity of known) {
        if (liveIdentities.has(identity)) continue;
        // 没有活 socket 的成员当场确认关闭；有 socket 的等 dismiss 后 close。
        const decision = lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "closeConfirmed",
            generation,
            identity,
        }));
        if (decision?.state.phase === "closed") {
            lifecycleRegistry.remove(roomNumber);
            return;
        }
    }
}

export function disbandRoom(roomNumber: string): boolean {
    const room = rooms.get(roomNumber);
    const lifecycle = lifecycleRegistry.get(roomNumber);
    const liveIdentities = new Set(
        sessionManager.getClientsInRoom(roomNumber).map(client => identityOf(client)),
    );
    lifecycleRegistry.dispatch(roomNumber, generation => ({
        type: "disband",
        generation,
        identity: null,
        nowMs: getRealNowMs(),
        closeDeadlineMs: LIFECYCLE_CLOSE_DEADLINE_MS,
    }));
    const deleted = rooms.delete(roomNumber);
    if (!deleted) {
        // 并发/重复解散：房间已不在主册，但可能还有残留 client；有才清，
        // 避免对不存在的房间发空 dismiss（保持“解散缺失房间不发通知”的契约）。
        if (sessionManager.getClientsInRoom(roomNumber).length > 0
            || sessionManager.getBattleClientsInRoom(roomNumber).length > 0) {
            sessionManager.dismissRoomClients(roomNumber);
            sessionManager.closeBattleClientsForRoom(roomNumber);
        }
        // 重复解散：closing 已由第一次解除散负责，不在这里再次确认/remove。
        return false;
    }
    console.log(`[MULTI] room deleted: ${roomNumber}`);
    // 拆除咽喉：先摘名册发 dismiss，战斗 socket 立即关闭，房间状态最后清。
    // dismiss-only 由 SessionManager 保证（不在此 destroy 房间 socket）。
    sessionManager.dismissRoomClients(roomNumber);
    sessionManager.closeBattleClientsForRoom(roomNumber);
    sessionManager.removeRoomState(roomNumber);
    notifiedRooms.delete(roomNumber);
    notifyRoomDisbanded(roomNumber, room?.host_player_id ?? 0, room?.host_viewer_id ?? 0);
    settleDisbandedIdentities(roomNumber, lifecycle, liveIdentities);
    return true;
}

export function updateHostEntryTime(roomNumber: string): boolean {
    const room = rooms.get(roomNumber);
    if (!room) return false;
    // R-15=B：与清理逻辑同一时钟域
    room.host_entry_time = Math.floor(getRealNowMs() / 1000);
    return true;
}
