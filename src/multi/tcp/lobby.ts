import * as net from "net"
import { randomUUID } from "crypto"
import { describeError } from "../describe-error"
import { sessionManager, SessionClient, SessionMate } from "../state/SessionManager"
import {
    disbandRoom,
    getRoom,
    isRoomMember,
    removeRoomMember,
    updateHostEntryTime,
    updateRoomState,
    updateRoomStateFromKernel,
} from "../room/manager"
import { NpcMateProvider } from "../npc/controller"
import { ensureNpcRoster, getActiveNpcRoster } from "../npc/nickname-pool"
import { applyNpcPostFill } from "../npc/release"
import { closeRecruitmentForRoom, updateOpenRecruitmentSnapshotForRoom } from "../../data/domains/attention"
import { isEffectSwitched } from "../lifecycle/effect-executor"
import { npcIdentityOf } from "../npc/identity"
import { recordEntryStage } from "../lifecycle/entry-pipeline"
import { incrementFollowBonusForBattle } from "../../lib/follow-bonus"
import { safeEvolutionImgLevel } from "../safe-display-fields"
import { getRealNowMs } from "../../runtime/time/game-time"
import type { MultiRoom } from "../../lib/types"
import { RoomState } from "../types"
import { identityOf, lifecycleRegistry } from "../lifecycle"
import {
    getLobbyLifecycleGuard,
    LobbyLifecycleGuard,
    scheduleLobbyTask,
} from "./lobby-lifecycle"
import { updatePlayerSnapshotParty } from "../snapshot/player-snapshot"
import { participantKey, type ParticipantIdentity } from "../coordinator/contracts"

const DEFAULT_NPC_JOIN_DELAY_MS = 2_000
const DEFAULT_NPC_READY_DELAY_MS = 500

export interface NpcRecruitmentTiming {
    readonly joinDelayMs: number
    readonly readyDelayMs: number
}

let npcRecruitmentTiming: NpcRecruitmentTiming = Object.freeze({
    joinDelayMs: DEFAULT_NPC_JOIN_DELAY_MS,
    readyDelayMs: DEFAULT_NPC_READY_DELAY_MS,
})

// 好友房间大厅注册行同步（惰性 require 规避循环；无注册行 no-op）
function syncShareRow(roomNumber: string): void {
    try {
        const { syncRoomShareRow } = require("../room/share-sync") as typeof import("../room/share-sync")
        syncRoomShareRow(roomNumber)
    } catch (error) {
        console.warn("[LOBBY] room share sync failed", roomNumber, describeError(error))
    }
}

// 按连接身份清理 mate：同一 viewerId 重连会获得新 connectionId，
// 裸 viewerId 清理会误删重连玩家（僵尸旧连接晚检测场景）。幂等。
function removeDisconnectedMate(roomNumber: string, connectionId: string): void {
    const room = getRoom(roomNumber)
    if (!room) return
    const hostClient = findHostClient(roomNumber)
    for (const connectedClient of sessionManager.getClientsInRoom(roomNumber)) {
        connectedClient.mates = connectedClient.mates
            .filter(mate => mate.connectionId !== connectionId)
    }
    if (hostClient) {
        room.mates = hostClient.mates.map(mate => ({
            viewer_id: mate.viewerId ?? null,
            com_id: mate.comId ?? 0,
        }))
        sessionManager.broadcastMateListToRoom(roomNumber, hostClient.mates)
    }
    // 无 host 连接时 room.mates 由房间权威状态在下次 host 广播时重建；
    // 裸 viewer_id 过滤同样会误伤重连者，故不做按 id 的删除。
    // 同步放在重建之后（双审 P1：先删后同步会把移除前的旧人数写进注册行）
    syncShareRow(roomNumber)
}

export function configureNpcRecruitmentTiming(
    options: Partial<NpcRecruitmentTiming> = {},
): void {
    npcRecruitmentTiming = Object.freeze({
        joinDelayMs: options.joinDelayMs ?? DEFAULT_NPC_JOIN_DELAY_MS,
        readyDelayMs: options.readyDelayMs ?? DEFAULT_NPC_READY_DELAY_MS,
    })
}

export function resetNpcRecruitmentTiming(): void {
    configureNpcRecruitmentTiming()
}

interface RoomRecruitmentState {
    nextRequestId: number
    committedRequestId: number
    revision: number
}

const roomRecruitmentStates = new WeakMap<MultiRoom, RoomRecruitmentState>()

function getRoomRecruitmentState(room: MultiRoom): RoomRecruitmentState {
    let state = roomRecruitmentStates.get(room)
    if (!state) {
        state = { nextRequestId: 0, committedRequestId: 0, revision: 0 }
        roomRecruitmentStates.set(room, state)
    }
    return state
}

function beginRecruitmentRequest(room: MultiRoom): number {
    const state = getRoomRecruitmentState(room)
    state.nextRequestId++
    return state.nextRequestId
}

function commitRecruitmentRequest(room: MultiRoom, requestId: number): number | null {
    const state = getRoomRecruitmentState(room)
    if (requestId < state.committedRequestId) return null
    state.committedRequestId = requestId
    state.revision++
    return state.revision
}

export function advanceRecruitmentGeneration(room: MultiRoom): number | null {
    return commitRecruitmentRequest(room, beginRecruitmentRequest(room))
}

function isCommittedRecruitment(roomNumber: string, room: MultiRoom, revision: number): boolean {
    return getRoom(roomNumber) === room && getRoomRecruitmentState(room).revision === revision
}

function findClientBySocket(socket: net.Socket): SessionClient | undefined {
    return sessionManager.getLobbyClientBySocket(socket)
}

function findHostClient(roomNumber: string): SessionClient | undefined {
    return sessionManager.getRoomHostClient(roomNumber)
}

function countRealPlayers(mates: any[]): number {
    return mates.filter(m => !m.comId).length  // real player has no comId
}

function selectRealMates(mates: any[], hostViewerId: number): any[] {
    const seenViewerIds = new Set<number>()
    let hostMate: any | undefined
    const guestMates: any[] = []
    for (const mate of mates) {
        if (mate.comId || seenViewerIds.has(mate.viewerId)) continue
        seenViewerIds.add(mate.viewerId)
        if (mate.viewerId === hostViewerId) hostMate = mate
        else guestMates.push(mate)
    }
    return (hostMate ? [hostMate, ...guestMates] : guestMates).slice(0, 3)
}

function getConnectedRealMates(client: SessionClient, room: MultiRoom): any[] {
    const connectedMates = sessionManager.getClientsInRoom(client.roomNumber)
        .filter(connectedClient => room.member_participants.some(member => (
            member.nodeSessionId === connectedClient.participant?.nodeSessionId
            && member.viewerId === connectedClient.participant.viewerId
        )))
        .map(connectedClient => connectedClient.yourself)
        .filter(mate => mate !== undefined)
    return selectRealMates(connectedMates, room.host_viewer_id)
}

function getAvailableNpcSlotCount(room: MultiRoom, realMates: any[]): number {
    // 2a1.2：空闲名额改读内核（容量恒 3，seats 含已入座 NPC，joiners 含真人
    // pending 票——票先占座阻断后续 NPC admit，D8 语义）。无内核条目（旧房
    // 兜底）退回真人计数。
    const state = lifecycleRegistry.get(room.room_number)
    if (!state) return Math.max(0, 3 - realMates.length)
    return Math.max(0, 3 - state.seats.length - Object.keys(state.joiners).length)
}

// 招募代存活判定：一场一换只在战斗 release 时清 NPC（one-shot clearRoomNpcRoster，
// npc_count→0 + 过滤 com_id>0）。因此 npc_count>0 且 room.mates 残留 com_id>0 投影
// ⇒ 自上次招募提交后未开战，此刻的 host Enter 是重连恢复而非 rematch。
function limitLobbyMates(mates: any[], hostViewerId: number): any[] {
    // 2a1.2：已入座 NPC 是占座参与者，不再被真人挤掉（D8：先到先得，抢输
    // 才销毁——销毁只发生在虚拟 admit 被拒的提交点，见 handleEnterComs）。
    // 展示上限仍 3：真人全保留，NPC 按剩余展示位截尾。
    const realMates = selectRealMates(mates, hostViewerId)
    const npcSlots = Math.max(0, 3 - realMates.length)
    const npcMates = npcSlots > 0
        ? mates.filter(mate => !!mate.comId).slice(-npcSlots)
        : []
    return [...realMates, ...npcMates]
}

export function commitRoomMates(client: SessionClient, room: MultiRoom, mates: any[]): void {
    client.mates = mates
    const hostClient = findHostClient(client.roomNumber)
    if (hostClient) hostClient.mates = client.mates
    room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
    syncShareRow(room.room_number)
}

export function checkHostAutoReady(roomNumber: string): void {
    const room = getRoom(roomNumber)
    if (!room) return
    const hostClient = findHostClient(roomNumber)
    if (!hostClient) return
    const hostMate = hostClient.mates.find(m => m.viewerId === hostClient.viewerId)
    if (!hostMate) return

    const nonHostReady = hostClient.mates.every(m =>
        m.viewerId === hostClient.viewerId || m.state?.[0] === 1
    )
    if (nonHostReady && hostClient.mates.length > 1) {
        if (hostMate.state?.[0] !== 1) {
            hostMate.state = [1]
            sessionManager.broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [1]]])
            console.log(`[LOBBY] host auto-ready: room=${roomNumber}`)
            if (hostClient.participant) {
                lifecycleRegistry.dispatch(roomNumber, generation => ({
                    type: "ready",
                    generation,
                    identity: identityOf(hostClient.participant!),
                    ready: true,
                }), hostClient.lifecycleGeneration)
            }
        }
    } else {
        if (hostMate.state?.[0] === 1) {
            hostMate.state = [0]
            sessionManager.broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [0]]])
            console.log(`[LOBBY] host auto-ready cancelled: room=${roomNumber}`)
            if (hostClient.participant) {
                lifecycleRegistry.dispatch(roomNumber, generation => ({
                    type: "ready",
                    generation,
                    identity: identityOf(hostClient.participant!),
                    ready: false,
                }), hostClient.lifecycleGeneration)
            }
        }
    }
    checkAllReadyAndStart(roomNumber)
}

const autoStartingRooms = new Set<string>()
const MAX_LOG_TAG = 255

function formatLogTag(value: unknown): string {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= MAX_LOG_TAG
        ? String(value)
        : "invalid"
}

function checkAllReadyAndStart(roomNumber: string): void {
    if (autoStartingRooms.has(roomNumber)) return
    const hostClient = findHostClient(roomNumber)
    if (!hostClient) return
    const room = getRoom(roomNumber)
    if (!room) return

    // Guard: wait for all expected real players to return on rematch
    if (room.npc_count > 0) {
        const realPlayers = countRealPlayers(hostClient.mates)
        const expectedReal = 3 - room.npc_count
        if (realPlayers < expectedReal) return
    }
    if (hostClient.mates.length < 3) return

    const allReady = hostClient.mates.every(m => m.state?.[0] === 1)
    if (!allReady) return

    autoStartingRooms.add(roomNumber)
    console.log(`[LOBBY] all ready — StartRemainingTime float: room=${roomNumber}`)
    sessionManager.broadcastToRoom(roomNumber, [1, [10, 2]])
}

/**
 * 2c.1:成员投影的唯一排序权威——按内核 seats 序逐身份投影(real→连接
 * 客户端的 yourself;npc→buildNpcLobbyMate),pending joiner(票先占座、
 * 尚未入座)按 joiner 序追尾。真机回归的排序问题([房主|B|NPC] 应为
 * [房主|NPC|B])即由本函数统一:任何重建/合并路径不得再自行排序。
 */
export function projectRoomMatesFromKernel(roomNumber: string, forClient: SessionClient): any[] {
    const room = getRoom(roomNumber)
    if (!room) return forClient.mates
    const state = lifecycleRegistry.get(roomNumber)
    if (!state) return forClient.mates
    const projected: any[] = []
    const projectedViewers = new Set<number>()
    const seatNpcIds = new Set<string>()
    for (const identity of state.seats) {
        if (identity.startsWith("npc:")) {
            seatNpcIds.add(identity)
            const comId = Number(identity.slice("npc:".length + roomNumber.length + 1))
            const assignment = room.npc_roster.find(candidate => candidate.com_id === comId)
            if (assignment) {
                // 2c.2:ready 权威在 roster(assignment.ready),重建天然保持
                projected.push(buildNpcLobbyMate(forClient, roomNumber, assignment))
            }
            continue
        }
        const viewerId = Number(identity.slice("viewer:".length))
        const member = sessionManager
            .getClientsInRoom(roomNumber)
            .find(candidate => candidate.viewerId === viewerId)
        const yourself = member?.yourself
        if (yourself) {
            projected.push(yourself)
            projectedViewers.add(viewerId)
        }
    }
    for (const identity of Object.keys(state.joiners)) {
        if (identity.startsWith("npc:") || seatNpcIds.has(identity)) continue
        if (state.seats.includes(identity)) continue
        const viewerId = Number(identity.slice("viewer:".length))
        if (projectedViewers.has(viewerId)) continue
        const member = sessionManager
            .getClientsInRoom(roomNumber)
            .find(candidate => candidate.viewerId === viewerId)
        if (member?.yourself) {
            projected.push(member.yourself)
            projectedViewers.add(viewerId)
        }
    }
    return projected
}

function buildNpcLobbyMate(
    client: SessionClient,
    roomNumber: string,
    assignment: { com_id: number, name: string, viewer_id?: number, ready?: boolean },
    recruitedViewerId?: number,
): any {
    const hostMate = client.yourself ?? client.mates[0]
    const comId = assignment.com_id
    const viewerId = recruitedViewerId ?? assignment.viewer_id ?? (900000000 + comId)
    const party = client.npcPartySnapshots[comId - 1]
        ?? client.npcPartySnapshots[0]
        ?? hostMate?.party
    return {
        viewerId,
        comId,
        name: assignment.name,
        rank: hostMate?.rank,
        degreeId: hostMate?.degreeId,
        playerRoleKind: 99,
        party,
        connectionId: `${roomNumber}-npc-${comId}`,
        autoplayMode: false,
        autoskillMode: 1,
        autoSpeedLevel: 1,
        autoStart: false,
        skillAbilityBehaviorMode: 1,
        dashBehaviorMode: 1,
        allowHealFromOtherPlayers: true,
        state: [assignment.ready ? 1 : 0],
        entryTime: getRealNowMs(),
        isNewbie: false,
        isHost: false,
    }
}

export async function handleEnterComs(
    client: SessionClient,
    lifecycle: LobbyLifecycleGuard = getLobbyLifecycleGuard(),
    options: { joinBroadcastDelayMs?: number } = {},
): Promise<void> {
    const room = getRoom(client.roomNumber)
    if (!room) {
        sessionManager.dismissSingleClient(client)
        return
    }
    if (roomBattleLocksLobbyMutations(client.roomNumber)) {
        console.log(`[LOBBY] EnterComs rejected: room=${client.roomNumber} battle in progress`)
        return
    }
    room.is_npc_mode = true
    const requestId = beginRecruitmentRequest(room)

    const hostMate = client.yourself ?? client.mates[0]
    if (!hostMate) return

    const initialRealMates = getConnectedRealMates(client, room)
    // 双检：请求已被更新的一代废弃（开战/一场一换清除 bump 过 revision）时
    // 不做任何副作用写入（npc_count/roster），直接让位
    if (requestId < getRoomRecruitmentState(room).committedRequestId) return

    // Assign the room roster synchronously so concurrent EnterComs calls share one binding.
    // 配额在每次招募激活时重算（3 − 当前真人）：上一轮成员变动（离开/加入）后的
    // 缺口在重新开启招募/注入的这一次提交中补齐（用户定案语义，非离开瞬间补位）。
    // 2a1 step 1：内核 setNpcCount 事件已删（容量恒 3，NPC 以占座参与者身份
    // 经虚拟 admit/enter 入座）；npc_count 只剩投影兼容字段。
    // 2c.2:招募引擎终态(NPC=玩家)——配额不预计算:补位时按"当时空位"创建
    // roster 条目并补一次(先到先得,与真人同链路);无 restore/重入特例
    //(NPC 的续战回房由 4→1 的虚拟续战承载,见 npc/rematch.ts)。
    // 早退闸门:零空位且无未入座候选 → 纯重建(不发招募)。
    // 真人投影过滤到内核参与者(seats ∪ joiners):票先占座。
    const kernelBeforeGate = lifecycleRegistry.get(client.roomNumber)
    const seatedNow: typeof room.npc_roster = []
    const unseated: typeof room.npc_roster = []
    for (const assignment of room.npc_roster) {
        const npcIdentity = npcIdentityOf(client.roomNumber, assignment.com_id)
        if (kernelBeforeGate !== undefined && kernelBeforeGate.seats.includes(npcIdentity)) {
            seatedNow.push(assignment)
        } else {
            unseated.push(assignment)
        }
    }
    const isKernelParticipant = (mate: { viewerId: number }): boolean => {
        if (kernelBeforeGate === undefined) return true
        const identity = `viewer:${mate.viewerId}`
        return kernelBeforeGate.seats.includes(identity) || kernelBeforeGate.joiners[identity] !== undefined
    }
    const initialRealParticipants = initialRealMates.filter(isKernelParticipant)
    const freeAtGate = getAvailableNpcSlotCount(room, initialRealMates)
    if (freeAtGate > 0) {
        // 补位时按当时空位创建 roster 条目(数量在补位时刻决定)
        ensureNpcRoster(room, seatedNow.length + freeAtGate)
        seatedNow.length = 0
        unseated.length = 0
        const kernelAfterEnsure = lifecycleRegistry.get(client.roomNumber)
        for (const assignment of room.npc_roster) {
            const npcIdentity = npcIdentityOf(client.roomNumber, assignment.com_id)
            if (kernelAfterEnsure !== undefined && kernelAfterEnsure.seats.includes(npcIdentity)) {
                seatedNow.push(assignment)
            } else {
                unseated.push(assignment)
            }
        }
    }
    room.npc_count = room.npc_roster.length
    const initialActiveCount = getAvailableNpcSlotCount(room, initialRealMates)
    if (initialActiveCount <= 0 || unseated.length === 0) {
        // 零空位(满员)或无未入座候选(纯重建):不发招募、不排定时器,
        // 投影 = 内核参与者(真人含 pending)+ 已入座 NPC
        commitRecruitmentRequest(room, requestId)
        commitRoomMates(client, room, projectRoomMatesFromKernel(client.roomNumber, client))
        const committedRevision = commitRecruitmentRequest(room, requestId)
        if (committedRevision === null) return
        // 重建后照排两个旧 restore 任务:0ms 全客户端名单广播 + 500ms NPC
        // ready(已入座 NPC 翻 ready → 房主 auto-ready 检查)
        scheduleLobbyTask(lifecycle => {
            try {
                if (!lifecycle.isActive()) return
                if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
                const currentHostClient = findHostClient(client.roomNumber)
                if (!currentHostClient) return
                for (const enteredClient of sessionManager.getClientsInRoom(client.roomNumber)) {
                    if (!enteredClient.enterData) continue
                    const projectedMates = sessionManager.projectMateListForClient(
                        enteredClient,
                        currentHostClient.mates,
                    )
                    enteredClient.mates = projectedMates
                    sessionManager.sendJson(enteredClient.socket, [1, [1, projectedMates]])
                }
            } catch { console.error("[LOBBY] EnterComs rebuild send-mates failed") }
        }, 0)
        if (seatedNow.length > 0) {
            scheduleLobbyTask(lifecycle => {
                try {
                    if (!lifecycle.isActive()) return
                    if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
                    const currentHostClient = findHostClient(client.roomNumber)
                    if (!currentHostClient) return
                    for (const npc of currentHostClient.mates) {
                        if (!npc.comId) continue
                        npc.state = [1]
                        sessionManager.broadcastToRoom(client.roomNumber, [1, [2, npc.connectionId, [1]]])
                    }
                    if (countRealPlayers(currentHostClient.mates) === 1) checkHostAutoReady(client.roomNumber)
                } catch { console.error("[LOBBY] EnterComs rebuild npc-ready failed") }
            }, npcRecruitmentTiming.readyDelayMs)
        }
        if (unseated.length === 0) {
            console.log(`[LOBBY] EnterComs: rebuild-only (seated=${seatedNow.length})`)
        } else {
            console.log(`[LOBBY] EnterComs: room full (${initialRealParticipants.length} players), skip NPCs`)
        }
        return
    }

    const npcProvider = new NpcMateProvider()
    const recruitResult = await npcProvider.onRecruit(client.roomNumber, String(room?.host_viewer_id ?? 0))
    if (!lifecycle.isActive() || getRoom(client.roomNumber) !== room) return
    if (requestId < getRoomRecruitmentState(room).committedRequestId) return

    // Real players may enter while the provider is pending. Rebuild from current room state.
    const currentRealMates = getConnectedRealMates(client, room).filter(isKernelParticipant)
    const freeSlots = getAvailableNpcSlotCount(room, currentRealMates)
    // 补位从 roster 尾部取(旧 getActiveNpcRoster slice(-count) 语义:com_id
    // 大者先填,与"真人替换 com_id 1"的替换次序一致)
    const tailStart = Math.max(0, unseated.length - freeSlots)
    const assignments = [...seatedNow, ...unseated.slice(tailStart)]

    // 2a1.2：NPC 以占座参与者身份走与真人相同的 admit→handshake→enter 流水线
    // （提交点同步三连派发，无 I/O）。admit 被拒=真人先到/满员 → 抢输销毁：
    // 该 NPC 移出 roster、不入 mates（先到先得，D8）。
    const seatedAssignments: typeof assignments = []
    for (const assignment of assignments) {
        const npcIdentity = npcIdentityOf(client.roomNumber, assignment.com_id)
        // 已在座(restore/重入路径):直接保留,不重复派发
        const kernelNow = lifecycleRegistry.get(client.roomNumber)
        if (kernelNow !== undefined && kernelNow.seats.includes(npcIdentity)) {
            seatedAssignments.push(assignment)
            continue
        }
        const admitDecision = lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "admit",
            generation,
            identity: npcIdentity,
        }))
        const destroy = (): void => {
            const index = room.npc_roster.indexOf(assignment)
            if (index >= 0) room.npc_roster.splice(index, 1)
        }
        if (admitDecision === null || admitDecision.rejected !== undefined) {
            destroy()
            continue
        }
        lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "handshake",
            generation,
            identity: npcIdentity,
        }))
        const enterDecision = lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "enter",
            generation,
            identity: npcIdentity,
            nowMs: getRealNowMs(),
        }))
        if (enterDecision === null || enterDecision.rejected !== undefined) {
            // 防御分支（admit 已锁定 joiner 名额，理论不可达）：抢输销毁
            destroy()
            continue
        }
        assignment.viewer_id = recruitResult.recruitedMates
            .find(recruited => recruited.com_id === assignment.com_id)?.viewer_id
            ?? (900000000 + assignment.com_id)
        seatedAssignments.push(assignment)
    }

    const npcMates: any[] = []
    const recruitedByComId = new Map(recruitResult.recruitedMates.map(mate => [mate.com_id, mate]))
    for (const assignment of seatedAssignments) {
        const recruited = recruitedByComId.get(assignment.com_id)
        npcMates.push(buildNpcLobbyMate(client, client.roomNumber, assignment, recruited?.viewer_id))
    }

    const committedRevision = commitRecruitmentRequest(room, requestId)
    if (committedRevision === null) return
    commitRoomMates(client, room, projectRoomMatesFromKernel(client.roomNumber, client))

    console.log(`[LOBBY] EnterComs: room=${client.roomNumber} real=${currentRealMates.length} npc=${npcMates.length} total=${client.mates.length}`)

    if (npcMates.length === 0) return

    // joinDelay 是招募剧场的"NPC 陆续进场"节奏；重连恢复传 0 跳过剧场直接还原名单
    const joinDelayMs = options.joinBroadcastDelayMs ?? npcRecruitmentTiming.joinDelayMs

    // postFill（设计 v2 §3）：NPC 进场提交后的招募行处置——close（官服）关招募 /
    // keep-open（私服）服务端接管行寿命。挂 commit 点（双审定案，非 summon 响应）。
    applyNpcPostFill(client.roomNumber)

    scheduleLobbyTask(lifecycle => {
        try {
            if (!lifecycle.isActive()) return
            if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
            const currentHostClient = findHostClient(client.roomNumber)
            if (!currentHostClient) return
            for (const enteredClient of sessionManager.getClientsInRoom(client.roomNumber)) {
                if (!enteredClient.enterData) continue
                const projectedMates = sessionManager.projectMateListForClient(
                    enteredClient,
                    currentHostClient.mates,
                )
                enteredClient.mates = projectedMates
                sessionManager.sendJson(enteredClient.socket, [1, [1, projectedMates]])
            }
        } catch { console.error("[LOBBY] EnterComs send-mates failed") }
    }, joinDelayMs)

    scheduleLobbyTask(lifecycle => {
        try {
            if (!lifecycle.isActive()) return
            if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
            const currentHostClient = findHostClient(client.roomNumber)
            if (!currentHostClient) return
            // ①只有准备状态:NPC 入座即 ready([1] 随投影)——任务仅保留
            // auto-ready 检查(500ms 时点=进场剧场到自动开战的固定间隔,
            // 让 NPC 玩家看起来更像真人玩家,维护者裁定保留)
            if (countRealPlayers(currentHostClient.mates) === 1) checkHostAutoReady(client.roomNumber)
        } catch { console.error("[LOBBY] EnterComs npc-ready failed") }
    }, joinDelayMs + npcRecruitmentTiming.readyDelayMs)
}

// An unreleased battle locks the lobby: while raising_state=4 the party,
// ready flags, NPC roster, and room state belong to the frozen battle, no
// matter whether battle sockets are currently online (socket presence only
// reflects occupancy, not battle ownership). Only the official release,
// which returns the room to Ready, reopens these mutations for the rematch.
function roomBattleLocksLobbyMutations(roomNumber: string): boolean {
    const room = getRoom(roomNumber)
    return room?.raising_state === 4
}

function handleEnter(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const ed = data[1]
    if (!ed?.party || !client.yourself) return
    if (roomBattleLocksLobbyMutations(client.roomNumber)) {
        console.log(`[LOBBY] enter rejected: room=${client.roomNumber} battle in progress`)
        return
    }

    // 房间已删：不再静默丢包，直接 dismiss，让客户端立刻走解散流程。
    if (!getRoom(client.roomNumber)) {
        sessionManager.dismissSingleClient(client)
        console.log(`[LOBBY] enter after room deleted: room=${client.roomNumber}`)
        return
    }

    const room = getRoom(client.roomNumber)
    const isHost = !!client.participant
        && sessionManager.isRoomHostParticipant(client.roomNumber, client.participant)
    if (!isHost && (!room || !client.participant || !isRoomMember(room, client.participant))) return

    client.yourself.party = ed.party
    if (ed.autoplayMode !== undefined) client.yourself.autoplayMode = ed.autoplayMode;
    if (ed.autoskillMode !== undefined) client.yourself.autoskillMode = ed.autoskillMode;
    if (ed.autoSpeedLevel !== undefined) client.yourself.autoSpeedLevel = ed.autoSpeedLevel;
    if (ed.autoStart !== undefined) client.yourself.autoStart = ed.autoStart;
    if (ed.skillAbilityBehaviorMode !== undefined) client.yourself.skillAbilityBehaviorMode = ed.skillAbilityBehaviorMode;
    if (ed.dashBehaviorMode !== undefined) client.yourself.dashBehaviorMode = ed.dashBehaviorMode;
    if (ed.allowHealFromOtherPlayers !== undefined) client.yourself.allowHealFromOtherPlayers = ed.allowHealFromOtherPlayers;
    client.enterData = ed
    // B2a 影子：记录 enter；房主首次 enter 在内核里 recruiting → ready。
    if (client.participant) {
        const enterDecision = lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "enter",
            generation,
            identity: identityOf(client.participant!),
            nowMs: getRealNowMs(),
        }), client.lifecycleGeneration)
        // 内核拒绝=握手后座位/相位已变化（迟到 Enter 被顶满）：不回 enter 帧，
        // dismiss 让客户端走拆除重进流程——外壳成员账不得越过内核账
        // （2026-10-31 真机 699560："guest entered"写在内核连拒之后）。
        if (enterDecision?.rejected) {
            recordEntryStage("enterRejected")
            recordEntryStage("rollbackMembersRemoved")
            removeRoomMember(client.roomNumber, client.participant!)
            sessionManager.dismissSingleClient(client)
            console.log(`[LOBBY] enter rejected by lifecycle: room=${client.roomNumber}`
                + ` reason=${enterDecision.rejected}`)
            return
        }
        recordEntryStage("enterAccepted")
        // HostReturn 清空 ready 后，房主重进时按客户端当前 ready 重新同步。
        lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "ready",
            generation,
            identity: identityOf(client.participant!),
            ready: client.isReady,
        }), client.lifecycleGeneration)
    }

    if (isHost) {
        updateRoomStateFromKernel(client.roomNumber)
        updateHostEntryTime(client.roomNumber)
        // 房内切换编队的即时刷新：重写 open 招募的房主快照（角色 = 本次上报
        // 编队一号位）。尽力而为：失败由 15s 重发兜底。进化等级按房间主人的
        // 玩家行实查（client 会话不携带 playerId）。
        try {
            const enteredRoom = getRoom(client.roomNumber)
            const hostPlayerId = enteredRoom?.host_player_id
            const leaderId = Array.isArray(ed.party?.characterIds)
                ? ed.party.characterIds.find((id: unknown) => typeof id === "number" && id > 0) ?? 0
                : 0
            if (hostPlayerId !== undefined && leaderId > 0) {
                // 异步形状的拒绝必须就地捕获——try/catch 不接 async 拒绝，
                // unhandled rejection 会被 node:test 记到当前用例头上
                void updateOpenRecruitmentSnapshotForRoom(
                    hostPlayerId,
                    client.viewerId,
                    client.roomNumber,
                    getRealNowMs(),
                    {
                        character: leaderId,
                        evolutionImgLevel: safeEvolutionImgLevel(hostPlayerId, leaderId),
                    },
                ).catch(error => {
                    console.warn(`[LOBBY] recruitment snapshot refresh rejected: room=${client.roomNumber}`, describeError(error))
                })
            }
        } catch (error) {
            console.warn(`[LOBBY] in-room bell snapshot refresh failed room=${client.roomNumber}`, describeError(error))
        }
    }

    const hostClient = findHostClient(client.roomNumber)

    // Guest entered before host (or host connected but hasn't entered) → wait with Welcome
    if (!isHost && (!hostClient || !hostClient.mates[0])) {
        client.mates = [client.yourself!]
        sessionManager.sendJson(client.socket, [1, [0, client.yourself, [client.yourself]]])
        console.log(`[LOBBY] guest entered alone: room=${client.roomNumber}`)
        return
    }

    if (isHost) {
        if (room) {
            // 2c.2:NPC=玩家——房主重入无任何 NPC 特殊逻辑;已入座 NPC 在内核
            // 座位上自然保持,续战回房由 4→1 的虚拟续战承载(npc/rematch.ts)。
            // 投影统一走内核 seats 序重建。
            commitRoomMates(client, room, projectRoomMatesFromKernel(client.roomNumber, client))
        }
        if (client.mates.length > 1) {
            sessionManager.broadcastMateListToRoom(client.roomNumber, client.mates, client)
        }
    } else {
        if (hostClient && client.yourself) {
            // 2c.1:投影排序权=内核 seats 序(内核 enter 已派发,本客机在
            // seats 尾)——guest-merge push 排序废止,顺序问题就此收口
            const projected = projectRoomMatesFromKernel(client.roomNumber, hostClient)
            hostClient.mates = projected
            client.mates = [...hostClient.mates]
        } else {
            client.mates = [client.yourself!]
        }
        if (room) {
            room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
            syncShareRow(room.room_number)
        }
    }

    const yourself = client.yourself
    if (yourself) {
        sessionManager.sendJson(client.socket, [1, [0, yourself, [yourself]]])
    }

    if (!isHost) {
        const mates = hostClient?.mates ?? client.mates
        sessionManager.broadcastMateListToRoom(client.roomNumber, mates)
    }

    console.log(`[LOBBY] ${isHost ? "host" : "guest"} entered: room=${client.roomNumber}`)
}

function disconnectRoomClient(client: SessionClient, reason: "network" | "explicit"): void {
    const isHost = !!client.participant
        && sessionManager.isRoomHostParticipant(client.roomNumber, client.participant)
    const room = getRoom(client.roomNumber)
    const preserveActiveBattle = room?.raising_state === 4
    // B2a 影子：state 4 的内核会忽略 socketLost（战斗 socket 才是存活判据）。
    if (client.participant) {
        lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "socketLost",
            generation,
            identity: identityOf(client.participant!),
        }), client.lifecycleGeneration)
    }

    if (preserveActiveBattle) {
        sessionManager.removeClient(client)
        try { client.socket.destroy() } catch {}
        console.log(`[LOBBY] client left: role=${isHost ? "host" : "guest"} room=${client.roomNumber}`)
        return
    }

    if (reason === "network") {
        // 房主网络断开不重写 mates：房主席位保留，由 host-offline 投影与老化回收处理。
        if (!isHost) removeDisconnectedMate(client.roomNumber, client.connectionId)
        sessionManager.removeClient(client)
        if (!isHost && client.participant) {
            // 客机宽限已删除：网络断开即释放座位；重连走完整准备/入场。
            // 2a2:客机断线只重算真人,不自动补 NPC（D8 触发矩阵:guest
            // disconnect 不新增,除非房主主动重开招募）。
            removeRoomMember(client.roomNumber, client.participant)
        }
        console.log(`[LOBBY] client disconnected: role=${isHost ? "host" : "guest"} room=${client.roomNumber}`)
        return
    }

    for (const connectedClient of sessionManager.getClientsInRoom(client.roomNumber)) {
        if (connectedClient !== client) {
            connectedClient.mates = connectedClient.mates
                .filter(mate => mate.connectionId !== client.connectionId)
        }
    }
    const hostClient = findHostClient(client.roomNumber)
    if (client.participant) removeRoomMember(client.roomNumber, client.participant)
    sessionManager.removeClient(client)
    if (isHost && !preserveActiveBattle) disbandRoom(client.roomNumber)
    // Only refresh the mate list if the room still exists AND a *different* client is the host (i.e. a
    // guest left but the room lives on). If the room was disbanded (host left / went empty), the
    // [6, dismissed] broadcast already tore it down — pushing a stale/empty mate list here makes the
    // remaining client's refreshMates dereference undefined character-display data and crash (F1010).
    const survivedRoom = getRoom(client.roomNumber)
    if (survivedRoom && hostClient && hostClient !== client) {
        // N6：显式离席后 room.mates 以房主会话为权威重写（离席者已被上面的
        // 过滤循环从 hostClient.mates 移除）。注册行 mates 计数、NPC one-shot
        // 投影过滤读同一份投影,不重写会把已离席成员
        // 留在好友大厅计数里。
        survivedRoom.mates = hostClient.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
        sessionManager.broadcastMateListToRoom(client.roomNumber, hostClient.mates)
    }
    if (survivedRoom) syncShareRow(client.roomNumber)
    try { client.socket.destroy(); } catch (e) {}
    console.log(`[LOBBY] client left: role=${isHost ? "host" : "guest"} room=${client.roomNumber}`)
}

export function handleSocketDisconnect(socket: net.Socket): boolean {
    const client = findClientBySocket(socket)
    if (!client) return false
    disconnectRoomClient(client, "network")
    return true
}

export function handleInvalidNodeSession(socket: net.Socket): boolean {
    const client = findClientBySocket(socket)
    if (!client) return false
    disconnectRoomClient(client, "explicit")
    return true
}

function handleBye(_socket: net.Socket, client: SessionClient, _data: any[]): void {
    disconnectRoomClient(client, "explicit")
}

function handleChangeParty(_socket: net.Socket, client: SessionClient, data: any[]): void {
    if (roomBattleLocksLobbyMutations(client.roomNumber)) {
        console.log(`[LOBBY] party change rejected: room=${client.roomNumber} battle in progress`)
        return
    }
    const pd = data[1]
    if (pd?.party && client.yourself) {
        if (client.snapshot) {
            client.snapshot = updatePlayerSnapshotParty(
                client.snapshot,
                pd.party,
                pd.currentPartyId ?? client.snapshot.currentPartyId,
            )
            client.yourself.party = client.snapshot.party
            client.yourself.currentPartyId = client.snapshot.currentPartyId
        } else {
            client.yourself.party = pd.party
            if (pd.currentPartyId !== undefined) {
                client.yourself.currentPartyId = pd.currentPartyId
            }
        }
    }
    const mate = client.mates.find(m => m.viewerId === client.viewerId)
    if (mate) {
        const room = getRoom(client.roomNumber); if (room) { room.host_party_id = pd.currentPartyId; }
        const hostClient = findHostClient(client.roomNumber)
        sessionManager.broadcastMateListToRoom(client.roomNumber, hostClient?.mates ?? client.mates)
    }
    console.log(`[LOBBY] party changed: room=${client.roomNumber}`)
}

function updateCurrentMateSettings(
    client: SessionClient,
    settings: Partial<SessionMate>,
): void {
    const hostClient = findHostClient(client.roomNumber)
    const authoritativeMates = hostClient?.mates ?? client.mates
    const updatedMates = authoritativeMates.map(mate => (
        !mate.comId && mate.viewerId === client.viewerId
            ? { ...mate, ...settings }
            : mate
    ))
    const updatedMate = updatedMates.find(mate => (
        !mate.comId && mate.viewerId === client.viewerId
    ))
    if (!updatedMate) return

    for (const roomClient of sessionManager.getClientsInRoom(client.roomNumber)) {
        roomClient.mates = updatedMates
        if (roomClient.viewerId === client.viewerId) roomClient.yourself = updatedMate
    }
    const room = getRoom(client.roomNumber)
    if (room) {
        room.mates = updatedMates.map(mate => ({
            viewer_id: mate.viewerId ?? null,
            com_id: mate.comId ?? 0,
        }))
        syncShareRow(room.room_number)
    }
    sessionManager.broadcastMateListToRoom(client.roomNumber, updatedMates)
}

function handleChangeAutoplay(client: SessionClient, data: any[]): void {
    if (typeof data[1] !== "boolean") return
    const settings: Partial<SessionMate> = { autoplayMode: data[1] }
    if (data[2] === true) settings.autoSpeedLevel = 1
    updateCurrentMateSettings(client, settings)
}

function handleChangeAutoStart(client: SessionClient, data: any[]): void {
    if (typeof data[1] !== "boolean") return
    updateCurrentMateSettings(client, { autoStart: data[1] })
}

function handleReady(_socket: net.Socket, client: SessionClient, data: any[]): void {
    if (roomBattleLocksLobbyMutations(client.roomNumber)) {
        console.log(`[LOBBY] ready change rejected: room=${client.roomNumber} battle in progress`)
        return
    }
    const readyState = Array.isArray(data[1]) ? data[1][0] : data[1]
    client.isReady = readyState === 1
    if (client.participant) {
        lifecycleRegistry.dispatch(client.roomNumber, generation => ({
            type: "ready",
            generation,
            identity: identityOf(client.participant!),
            ready: client.isReady,
        }), client.lifecycleGeneration)
    }

    const mate = client.mates.find(m => m.viewerId === client.viewerId)
    if (mate) {
        mate.state = data[1] ?? [1]
        sessionManager.broadcastToRoom(client.roomNumber, [1, [2, mate.connectionId, mate.state]])
    }

    checkHostAutoReady(client.roomNumber)
    console.log(`[LOBBY] ready changed: room=${client.roomNumber} ready=${client.isReady}`)
}

function handleHeartbeat(socket: net.Socket, client: SessionClient, _data: any[]): void {
    sessionManager.sendJson(socket, [1, [11, client.connectionId]])
}

// Narrow StartBattle commit boundary: validate without side effects, publish
// the battle runtime, then move the room into Battle. If the room refuses the
// transition the freshly published runtime is rolled back, so a rejected
// start can never leave a half-committed battle behind.
function beginBattle(client: SessionClient): boolean {
    const room = getRoom(client.roomNumber)
    if (!room || !client.participant
        || !sessionManager.isRoomHostParticipant(client.roomNumber, client.participant)) return false
    // 结算期 state 4 驻留变长：重发 StartBattle 不得在结算中开第二局。
    if (room.raising_state === 4) return false
    if (sessionManager.hasBattleExpectedCount(client.roomNumber)) return false

    const realMembers = client.mates.filter(mate => !mate.comId)
    if (realMembers.length === 0) return false
    const participants: Array<{ connectionId: string, participant: ParticipantIdentity }> = []
    for (const mate of realMembers) {
        const member = sessionManager.getUniqueRoomClientByViewerId(
            Number(mate.viewerId),
            client.roomNumber,
        )
        if (!member?.participant) return false
        participants.push({
            connectionId: String(mate.connectionId ?? ""),
            participant: member.participant,
        })
    }
    // 2b.2:内核先行——预生成会话 id,先派发 startBattle;被拒(世代失效/
    // 相位不符)则零发布直接返回,通过后才发布运行时并派生写入 raising_state
    const battleSessionId = randomUUID()
    const startDecision = lifecycleRegistry.dispatch(client.roomNumber, generation => ({
        type: "startBattle",
        generation,
        identity: identityOf(client.participant!),
        battleSessionId,
    }), client.lifecycleGeneration)
    if (!startDecision || startDecision.rejected) {
        console.warn(`[LOBBY] StartBattle rejected by kernel: room=${client.roomNumber}`
            + ` reason=${startDecision?.rejected ?? "no-entry"}`)
        return false
    }

    advanceRecruitmentGeneration(room)
    try {
        sessionManager.setBattleParticipants(client.roomNumber, participants, client.participant, battleSessionId)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[LOBBY] StartBattle rejected: room=${client.roomNumber} reason=${reason}`)
        sessionManager.clearBattleExpectedCount(client.roomNumber)
        return false
    }
    if (!updateRoomStateFromKernel(client.roomNumber)) {
        console.warn(`[LOBBY] StartBattle rolled back: room=${client.roomNumber} refused Battle`)
        sessionManager.clearBattleExpectedCount(client.roomNumber)
        return false
    }
    // 开战关招募（设计 §9.e）：战斗中铃铛必须停止；T1 阶段门只是投递侧兜底。
    // 切片 1 第③步：开关启用后由执行器消费内核 startBattle 的
    // closeRecruitment effect，此处停用（回退=摘掉 MULTI_EFFECT_SWITCHES）。
    // W1a：异步形状——同步上下文 fire-and-forget（拒绝就地捕获，try/catch
    // 不接 async 拒绝）
    if (!isEffectSwitched("closeRecruitment")) {
        void closeRecruitmentForRoom(room.host_viewer_id, client.roomNumber).catch(error => {
            console.warn(`[LOBBY] close recruitment on battle start failed: room=${client.roomNumber}`, describeError(error))
        })
    }
    // 关注奖励（v4）：每局恰好一次的本提交边界为计数点——局内真实成员间
    // 每条已存在的关注方向行 +10（单事务）。失败仅告警，不回滚开战。
    try {
        incrementFollowBonusForBattle(realMembers.map(mate => Number(mate.viewerId)))
    } catch (error) {
        console.warn(`[LOBBY] follow bonus increment failed: room=${client.roomNumber}`, describeError(error))
    }
    client.enterData = null
    return true
}

function handleStartBattle(_socket: net.Socket, client: SessionClient, _data: any[]): void {
    if (!beginBattle(client)) return

    autoStartingRooms.delete(client.roomNumber)
    const members = [...client.mates]
    sessionManager.broadcastToRoom(client.roomNumber, [1, [5, members]])
    console.log(`[LOBBY] StartBattle: room=${client.roomNumber} mates=${client.mates.length} expected=${members.filter(mate => !mate.comId).length}`)
}

function handleNotify(socket: net.Socket, client: SessionClient, data: any[]): void {
    const notifyData = data[1]
    if (!Array.isArray(notifyData)) return
    const tag = notifyData[0]

    switch (tag) {
        case 0: handleEnter(socket, client, notifyData); break
        case 1: handleBye(socket, client, notifyData); break
        case 2: handleChangeParty(socket, client, notifyData); break
        case 3: handleReady(socket, client, notifyData); break
        case 4: handleHeartbeat(socket, client, notifyData); break
        case 5: break  // Suspend
        case 7: handleChangeAutoplay(client, notifyData); break
        case 8: handleChangeAutoStart(client, notifyData); break
        case 9: break  // Log
        case 6: handleStartBattle(socket, client, notifyData); break
        case 10: handleEnterComs(client).catch(() => console.error("[LOBBY] EnterComs failed")); break
        default:
            console.log(`[LOBBY] unhandled Notify: tag=${formatLogTag(tag)}`)
    }
}

// Client2Server.Broadcast(1, payload)/Send(2, targets, payload) must be relayed
// as MeetingServer2Client.Messages(2, senderConnectionId, payload); echoing the
// raw client frame would make receivers parse the payload as a single
// MeetingServerMessage and lets any member inject arbitrary server messages.
// The sender renders its own emotion locally, so relays exclude it.
function handleBroadcast(_socket: net.Socket, client: SessionClient, data: any[]): void {
    sessionManager.broadcastToRoom(client.roomNumber, [2, client.connectionId, data[1]], client)
}

function handleSend(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const targetViewerIds = Array.isArray(data[1]) ? data[1] : [data[1]]
    for (const targetViewerId of targetViewerIds) {
        const target = sessionManager.getUniqueRoomClientByViewerId(targetViewerId, client.roomNumber)
        if (target) sessionManager.sendJson(target.socket, [2, client.connectionId, data[2]])
    }
}

export function handleMessage(socket: net.Socket, data: unknown): void {
    if (!Array.isArray(data)) return
    const tag = data[0]
    const client = findClientBySocket(socket)
    if (!client) {
        console.log(`[LOBBY] no client found for socket, dropping message tag=${formatLogTag(tag)}`)
        return
    }

    switch (tag) {
        case 0: handleNotify(socket, client, data); break
        case 1: handleBroadcast(socket, client, data); break
        case 2: handleSend(socket, client, data); break
        default:
            console.log(`[LOBBY] unhandled Client2Server: tag=${formatLogTag(tag)}`)
    }
}
