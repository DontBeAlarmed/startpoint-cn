// 切片 0 观测基线（行为不变）：回答"内核与外壳的多本账是否已经在运行期漂移"。
// 只计数、采样、经 server/status 暴露；不派生状态、不触发清理、不发任何帧。
// 依赖倒置：房间快照与 SessionManager 重复 client 统计由宿主（manager 清理
// tick）按参数传入，本模块只依赖内核注册表，避免 manager ↔ lifecycle 环。
// 样本不含客户端身份（viewer/session/token），detail 只带计数与阶段词。
//
// 五项不变量（重构评估文档 §6 切片 0）：
//   INV-1 rooms 有房间、内核无条目
//   INV-2 内核有条目、rooms 无，且 phase ∈ recruiting/ready/battle
//         （closing/closed 单独计入 kernelClosingOrphans——正常解散会先删
//         rooms、内核保留 closing 直到 closeConfirmed/5 分钟，按字面算会把
//         每次正常解散误报成漂移）
//   INV-3 room.member_participants 不在内核成员账。判据 = seats ∪ joiners，
//         battle 相位并上 battleParticipants——B3a 起 finish 释放座位后
//         seats 为空、参战者保留在 battleParticipants 直到 HostReturn 清空；
//         不并入它会把每个结算等待房误报成漂移（与 INV-2 的排除同一原则）。
//         NPC 房（npc_count>0）子集单独计数：2a 参与者模型前预期非零。
//   INV-4 同一 viewerId 同时持有多个活跃大厅 client
//   INV-5 closing 超过 close deadline 仍未 closed（sweep 间隔窗口内可见）

import { LIFECYCLE_CLOSE_DEADLINE_MS, lifecycleRegistry } from "./room-lifecycle-registry"
import { getRealNowMs } from "../../runtime/time/game-time"
import type { MultiRoom } from "../types"

export interface LifecycleDriftSample {
    readonly roomNumber: string
    readonly atMs: number
    readonly detail: string
}

export interface LifecycleDriftInvariantStats {
    readonly current: number
    readonly total: number
    readonly lastAtMs: number | null
    readonly samples: readonly LifecycleDriftSample[]
}

export interface LifecycleDriftStatus {
    readonly checkedAtMs: number
    readonly roomWithoutKernel: LifecycleDriftInvariantStats
    readonly kernelWithoutRoomActive: LifecycleDriftInvariantStats
    readonly kernelClosingOrphans: LifecycleDriftInvariantStats
    readonly memberNotInKernel: LifecycleDriftInvariantStats
    readonly memberNotInKernelNpcRooms: LifecycleDriftInvariantStats
    readonly viewerMultipleRoomClients: LifecycleDriftInvariantStats
    readonly closingPastDeadline: LifecycleDriftInvariantStats
}

export interface LifecycleDriftSampleInput {
    readonly rooms: readonly MultiRoom[]
    readonly viewerRoomClientDuplicates: {
        readonly viewers: number
        readonly maxClients: number
    }
}

const SAMPLE_LIMIT = 8
const SAMPLE_THROTTLE_MS = 60_000
const THROTTLE_MAP_LIMIT = 1024
const VIEWER_SCOPED_KEY = "*"

interface InvariantTracker {
    /** 当前处于漂移的 key 集合；离开后删除，复发再计一次 total */
    readonly drifted: Set<string>
    total: number
    lastAtMs: number | null
    readonly samples: LifecycleDriftSample[]
}

const DRIFT_INVARIANT_NAMES = [
    "roomWithoutKernel",
    "kernelWithoutRoomActive",
    "kernelClosingOrphans",
    "memberNotInKernel",
    "memberNotInKernelNpcRooms",
    "viewerMultipleRoomClients",
    "closingPastDeadline",
] as const

type DriftInvariantName = (typeof DRIFT_INVARIANT_NAMES)[number]

function createTracker(): InvariantTracker {
    return { drifted: new Set(), total: 0, lastAtMs: null, samples: [] }
}

const trackers: Record<DriftInvariantName, InvariantTracker> = {
    roomWithoutKernel: createTracker(),
    kernelWithoutRoomActive: createTracker(),
    kernelClosingOrphans: createTracker(),
    memberNotInKernel: createTracker(),
    memberNotInKernelNpcRooms: createTracker(),
    viewerMultipleRoomClients: createTracker(),
    closingPastDeadline: createTracker(),
}

const sampleThrottle = new Map<string, number>()

function record(
    name: DriftInvariantName,
    key: string,
    nowMs: number,
    sample: { readonly roomNumber: string; readonly detail: string } | null,
): void {
    const tracker = trackers[name]
    if (!tracker.drifted.has(key)) {
        tracker.drifted.add(key)
        tracker.total += 1
        tracker.lastAtMs = nowMs
    }
    if (sample === null) return
    const throttleKey = `${name}:${key}`
    const lastSampleAtMs = sampleThrottle.get(throttleKey) ?? 0
    if (nowMs - lastSampleAtMs < SAMPLE_THROTTLE_MS) return
    if (sampleThrottle.size >= THROTTLE_MAP_LIMIT) sampleThrottle.clear()
    sampleThrottle.set(throttleKey, nowMs)
    tracker.samples.unshift(Object.freeze({
        roomNumber: sample.roomNumber,
        atMs: nowMs,
        detail: sample.detail,
    }))
    if (tracker.samples.length > SAMPLE_LIMIT) tracker.samples.length = SAMPLE_LIMIT
}

function retire(name: DriftInvariantName, key: string): void {
    trackers[name].drifted.delete(key)
}

function retireMissing(name: DriftInvariantName, present: ReadonlySet<string>): void {
    const tracker = trackers[name]
    for (const key of [...tracker.drifted]) {
        if (!present.has(key)) tracker.drifted.delete(key)
    }
}

export function sampleLifecycleDrift(nowMs: number, input: LifecycleDriftSampleInput): void {
    const roomsByNumber = new Map<string, MultiRoom>()
    for (const room of input.rooms) roomsByNumber.set(room.room_number, room)

    // INV-1
    const inv1Present = new Set<string>()
    for (const room of input.rooms) {
        if (lifecycleRegistry.get(room.room_number) !== undefined) continue
        inv1Present.add(room.room_number)
        record("roomWithoutKernel", room.room_number, nowMs, {
            roomNumber: room.room_number,
            detail: `raisingState=${room.raising_state}`,
        })
    }
    retireMissing("roomWithoutKernel", inv1Present)

    // INV-2 + closing/closed 孤儿（不算漂移）
    const inv2Present = new Set<string>()
    const closingOrphanPresent = new Set<string>()
    for (const roomNumber of lifecycleRegistry.roomNumbers()) {
        const state = lifecycleRegistry.get(roomNumber)
        if (!state || roomsByNumber.has(roomNumber)) continue
        if (state.phase === "recruiting" || state.phase === "ready" || state.phase === "battle") {
            inv2Present.add(roomNumber)
            record("kernelWithoutRoomActive", roomNumber, nowMs, {
                roomNumber,
                detail: `phase=${state.phase}`,
            })
        } else {
            closingOrphanPresent.add(roomNumber)
            record("kernelClosingOrphans", roomNumber, nowMs, {
                roomNumber,
                detail: `phase=${state.phase}`,
            })
        }
    }
    retireMissing("kernelWithoutRoomActive", inv2Present)
    retireMissing("kernelClosingOrphans", closingOrphanPresent)

    // INV-3
    const inv3Present = new Set<string>()
    const inv3NpcPresent = new Set<string>()
    for (const room of input.rooms) {
        const state = lifecycleRegistry.get(room.room_number)
        if (!state) continue
        const memberUniverse = new Set<string>([
            ...state.seats,
            ...Object.keys(state.joiners),
            ...state.battleParticipants,
        ])
        let missing = 0
        for (const member of room.member_participants) {
            if (!memberUniverse.has(`viewer:${member.viewerId}`)) missing++
        }
        if (missing === 0) continue
        const detail = `members=${room.member_participants.length} missing=${missing} npc=${room.npc_count}`
        inv3Present.add(room.room_number)
        record("memberNotInKernel", room.room_number, nowMs, {
            roomNumber: room.room_number,
            detail,
        })
        if (room.npc_count > 0) {
            inv3NpcPresent.add(room.room_number)
            record("memberNotInKernelNpcRooms", room.room_number, nowMs, {
                roomNumber: room.room_number,
                detail,
            })
        }
    }
    retireMissing("memberNotInKernel", inv3Present)
    retireMissing("memberNotInKernelNpcRooms", inv3NpcPresent)

    // INV-4
    const inv4Present = new Set<string>()
    if (input.viewerRoomClientDuplicates.viewers > 0) {
        inv4Present.add(VIEWER_SCOPED_KEY)
        record("viewerMultipleRoomClients", VIEWER_SCOPED_KEY, nowMs, {
            roomNumber: "",
            detail: `viewers=${input.viewerRoomClientDuplicates.viewers}`
                + ` maxClients=${input.viewerRoomClientDuplicates.maxClients}`,
        })
    }
    retireMissing("viewerMultipleRoomClients", inv4Present)

    // INV-5
    const inv5Present = new Set<string>()
    for (const entry of lifecycleRegistry.closingEntries(nowMs)) {
        if (entry.ageMs <= LIFECYCLE_CLOSE_DEADLINE_MS) continue
        inv5Present.add(entry.roomNumber)
        record("closingPastDeadline", entry.roomNumber, nowMs, {
            roomNumber: entry.roomNumber,
            detail: `ageMs=${entry.ageMs}`,
        })
    }
    retireMissing("closingPastDeadline", inv5Present)
}

export function getLifecycleDriftStatus(): LifecycleDriftStatus {
    const snapshot = (tracker: InvariantTracker): LifecycleDriftInvariantStats => Object.freeze({
        current: tracker.drifted.size,
        total: tracker.total,
        lastAtMs: tracker.lastAtMs,
        samples: Object.freeze([...tracker.samples]),
    })
    return Object.freeze({
        checkedAtMs: getRealNowMs(),
        roomWithoutKernel: snapshot(trackers.roomWithoutKernel),
        kernelWithoutRoomActive: snapshot(trackers.kernelWithoutRoomActive),
        kernelClosingOrphans: snapshot(trackers.kernelClosingOrphans),
        memberNotInKernel: snapshot(trackers.memberNotInKernel),
        memberNotInKernelNpcRooms: snapshot(trackers.memberNotInKernelNpcRooms),
        viewerMultipleRoomClients: snapshot(trackers.viewerMultipleRoomClients),
        closingPastDeadline: snapshot(trackers.closingPastDeadline),
    })
}

/** 测试隔离：清空全部漂移观测状态（不影响内核注册表）。 */
export function resetLifecycleDriftForTest(): void {
    for (const name of DRIFT_INVARIANT_NAMES) trackers[name] = createTracker()
    sampleThrottle.clear()
}
