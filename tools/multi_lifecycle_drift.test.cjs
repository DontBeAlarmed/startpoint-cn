"use strict"

// 切片 0 漂移观测回归（行为不变）：五项不变量的计数/采样/retire 语义、
// closing 孤儿的单独计数、内核 reject 按原因计数、admin status 的
// drift/rejections 消毒（样本不含客户端身份）。只测观测层。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { test } = require("node:test")

const {
    LIFECYCLE_CLOSE_DEADLINE_MS,
    lifecycleRegistry,
} = require("../src/multi/lifecycle")
const {
    sampleLifecycleDrift,
    getLifecycleDriftStatus,
    resetLifecycleDriftForTest,
} = require("../src/multi/lifecycle/drift-monitor")
const { buildAdminMultiStatus } = require("../src/lib/admin-multi-status")

function baseRoom(roomNumber, overrides = {}) {
    return {
        room_number: roomNumber,
        raising_state: 2,
        npc_count: 0,
        member_participants: [],
        battle_participants: [],
        ...overrides,
    }
}

function fresh() {
    resetLifecycleDriftForTest()
    lifecycleRegistry.reset()
}

function sampleAt(nowMs, rooms, duplicates = { viewers: 0, maxClients: 0 }) {
    sampleLifecycleDrift(nowMs, { rooms, viewerRoomClientDuplicates: duplicates })
    return getLifecycleDriftStatus()
}

function dispatch(roomNumber, build) {
    const decision = lifecycleRegistry.dispatch(roomNumber, build)
    assert.ok(decision, `no lifecycle state for room ${roomNumber}`)
    return decision
}

test("INV-1 counts rooms without a kernel entry and re-counts after recovery", () => {
    fresh()
    const t0 = 1_000_000
    const drift = sampleAt(t0, [baseRoom("123456")])
    assert.equal(drift.roomWithoutKernel.current, 1)
    assert.equal(drift.roomWithoutKernel.total, 1)
    assert.equal(drift.roomWithoutKernel.lastAtMs, t0)
    assert.equal(drift.roomWithoutKernel.samples.length, 1)
    assert.equal(drift.roomWithoutKernel.samples[0].roomNumber, "123456")
    assert.equal(drift.roomWithoutKernel.samples[0].detail, "raisingState=2")

    // 同一房间仍在漂移：total 不重复计数，60s 节流内不追加样本
    const steady = sampleAt(t0 + 10_000, [baseRoom("123456")])
    assert.equal(steady.roomWithoutKernel.total, 1)
    assert.equal(steady.roomWithoutKernel.samples.length, 1)

    // 房间消失 → current 归零；复发 → total 再计一次
    sampleAt(t0 + 20_000, [])
    assert.equal(getLifecycleDriftStatus().roomWithoutKernel.current, 0)
    const again = sampleAt(t0 + 70_000, [baseRoom("123456")])
    assert.equal(again.roomWithoutKernel.total, 2)
    assert.equal(again.roomWithoutKernel.samples.length, 2)
})

test("INV-2 separates active orphans from normal closing orphans", () => {
    fresh()
    const t0 = 2_000_000
    lifecycleRegistry.create("234567", "viewer:1")

    // recruiting 阶段的孤儿是真漂移
    let drift = sampleAt(t0, [])
    assert.equal(drift.kernelWithoutRoomActive.current, 1)
    assert.equal(drift.kernelWithoutRoomActive.samples[0].detail, "phase=recruiting")
    assert.equal(drift.kernelClosingOrphans.current, 0)

    // 正常解散：内核保留 closing——单独计数，不算漂移
    const t1 = t0 + 1_000
    const decision = dispatch("234567", generation => ({
        type: "disband",
        generation,
        identity: null,
        nowMs: t1,
        closeDeadlineMs: 300_000,
    }))
    assert.equal(decision.rejected, undefined)
    drift = sampleAt(t1 + 1_000, [])
    assert.equal(drift.kernelWithoutRoomActive.current, 0)
    assert.equal(drift.kernelClosingOrphans.current, 1)
    assert.equal(drift.kernelClosingOrphans.samples[0].detail, "phase=closing")
})

test("INV-3 flags members missing from the kernel and marks NPC rooms", () => {
    fresh()
    const t0 = 3_000_000
    lifecycleRegistry.create("345678", "viewer:1")

    const drift = sampleAt(t0, [baseRoom("345678", {
        member_participants: [{ nodeSessionId: "n1", viewerId: 7 }],
    })])
    assert.equal(drift.memberNotInKernel.current, 1)
    assert.equal(drift.memberNotInKernelNpcRooms.current, 0)
    assert.equal(drift.memberNotInKernel.samples[0].detail, "members=1 missing=1 npc=0")

    // NPC 房子集单独标注（2a 参与者模型前预期非零）
    lifecycleRegistry.create("345679", "viewer:1")
    const npcDrift = sampleAt(t0 + 1_000, [baseRoom("345679", {
        npc_count: 2,
        member_participants: [{ nodeSessionId: "n1", viewerId: 7 }],
    })])
    assert.equal(npcDrift.memberNotInKernelNpcRooms.current, 1)
    assert.equal(npcDrift.memberNotInKernelNpcRooms.samples[0].detail, "members=1 missing=1 npc=2")
})

test("INV-3 does not flag settled battle members kept in battleParticipants", () => {
    fresh()
    const t0 = 4_000_000
    lifecycleRegistry.create("356789", "viewer:1")
    const chain = [
        generation => ({ type: "admit", generation, identity: "viewer:2" }),
        generation => ({ type: "handshake", generation, identity: "viewer:2" }),
        generation => ({ type: "enter", generation, identity: "viewer:2", nowMs: t0 }),
        // 房主首次 Enter 才把 recruiting→ready（startBattle 的前置）
        generation => ({ type: "enter", generation, identity: "viewer:1", nowMs: t0 }),
        generation => ({ type: "ready", generation, identity: "viewer:1", ready: true }),
        generation => ({ type: "ready", generation, identity: "viewer:2", ready: true }),
        generation => ({ type: "startBattle", generation, identity: "viewer:1", battleSessionId: "b1" }),
        generation => ({
            type: "finish", generation, identity: "viewer:2",
            nowMs: t0 + 1_000, battleDeadlineMs: 900_000, battleSessionId: "b1",
        }),
        generation => ({
            type: "finish", generation, identity: "viewer:1",
            nowMs: t0 + 2_000, battleDeadlineMs: 900_000, battleSessionId: "b1",
        }),
    ]
    for (const build of chain) {
        const decision = dispatch("356789", build)
        assert.equal(decision.rejected, undefined)
    }
    // B3a：finish 释放座位后 seats 只剩房主，参战者保留在 battleParticipants
    const state = lifecycleRegistry.get("356789")
    assert.ok(state.seats.includes("viewer:1"))
    assert.ok(state.battleParticipants.includes("viewer:2"))

    const drift = sampleAt(t0 + 3_000, [baseRoom("356789", {
        raising_state: 4,
        member_participants: [
            { nodeSessionId: "n1", viewerId: 1 },
            { nodeSessionId: "n2", viewerId: 2 },
        ],
    })])
    assert.equal(drift.memberNotInKernel.current, 0)
})

test("INV-4 counts duplicate room clients and retires on recovery", () => {
    fresh()
    const t0 = 5_000_000
    const drift = sampleAt(t0, [], { viewers: 2, maxClients: 3 })
    assert.equal(drift.viewerMultipleRoomClients.current, 1)
    assert.equal(drift.viewerMultipleRoomClients.samples[0].roomNumber, "")
    assert.equal(drift.viewerMultipleRoomClients.samples[0].detail, "viewers=2 maxClients=3")

    sampleAt(t0 + 1_000, [], { viewers: 0, maxClients: 0 })
    assert.equal(getLifecycleDriftStatus().viewerMultipleRoomClients.current, 0)
})

test("INV-5 flags closing entries past the close deadline", () => {
    fresh()
    const t0 = 6_000_000
    lifecycleRegistry.create("456789", "viewer:1")
    dispatch("456789", generation => ({
        type: "disband",
        generation,
        identity: null,
        nowMs: t0,
        closeDeadlineMs: LIFECYCLE_CLOSE_DEADLINE_MS,
    }))
    const beforeDeadline = sampleAt(t0 + 1_000, [])
    assert.equal(beforeDeadline.closingPastDeadline.current, 0)
    const pastDeadline = sampleAt(t0 + LIFECYCLE_CLOSE_DEADLINE_MS + 1_000, [])
    assert.equal(pastDeadline.closingPastDeadline.current, 1)
    assert.ok(pastDeadline.closingPastDeadline.samples[0].detail.startsWith("ageMs="))
})

test("registry counts rejections per reason and reset clears them", () => {
    fresh()
    lifecycleRegistry.create("567890", "viewer:1")
    for (let attempt = 0; attempt < 2; attempt++) {
        const decision = dispatch("567890", generation => ({
            type: "enter",
            generation,
            identity: "viewer:99",
            nowMs: 7_000_000,
        }))
        assert.equal(decision.rejected, "ADMISSION_REQUIRED")
    }
    const stats = lifecycleRegistry.stats()
    assert.equal(stats.rejections, 2)
    assert.equal(stats.rejectionReasons.ADMISSION_REQUIRED, 2)
    lifecycleRegistry.reset()
    assert.deepEqual(lifecycleRegistry.stats().rejectionReasons, {})
    assert.equal(lifecycleRegistry.stats().rejections, 0)
})

test("admin status passes drift and rejections through and drops identity leaks", () => {
    fresh()
    const runtime = {
        mode: "host",
        state: "ready",
        coordinator: { kind: "local", available: true },
        hub: null,
        tcp: { available: true, endpoint: "127.0.0.1:8003" },
    }
    const driftInvariant = {
        current: 1,
        total: 3,
        lastAtMs: 1_000,
        samples: [
            { roomNumber: "123456", atMs: 1_000, detail: "raisingState=2" },
            { roomNumber: "123456", atMs: 2_000, detail: "leak viewer:42 session:abc token" },
            { roomNumber: "not-a-room", atMs: 3_000, detail: "ok" },
        ],
    }
    const lifecycle = {
        closingRooms: 0,
        closingOldestAgeMs: 0,
        sweptClosing: 0,
        lastSweptClosingAtMs: null,
        forcedDismissCloses: 0,
        lastForcedClose: null,
        drift: {
            checkedAtMs: 5_000,
            roomWithoutKernel: driftInvariant,
            kernelWithoutRoomActive: { current: 0, total: 0, lastAtMs: null, samples: [] },
            kernelClosingOrphans: { current: 0, total: 0, lastAtMs: null, samples: [] },
            memberNotInKernel: { current: 0, total: 0, lastAtMs: null, samples: [] },
            memberNotInKernelNpcRooms: { current: 0, total: 0, lastAtMs: null, samples: [] },
            viewerMultipleRoomClients: { current: 0, total: 0, lastAtMs: null, samples: [] },
            closingPastDeadline: { current: 0, total: 0, lastAtMs: null, samples: [] },
        },
        rejections: { total: 4, byReason: { ADMISSION_REQUIRED: 3, ROOM_FULL: 1 } },
    }
    const result = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle,
    })
    assert.equal(result.lifecycle.drift.checkedAtMs, 5_000)
    assert.equal(result.lifecycle.drift.roomWithoutKernel.total, 3)
    // 身份样本与非法房号样本被丢弃，合法样本保留
    assert.equal(result.lifecycle.drift.roomWithoutKernel.samples.length, 1)
    assert.equal(result.lifecycle.drift.roomWithoutKernel.samples[0].detail, "raisingState=2")
    assert.equal(result.lifecycle.rejections.total, 4)
    assert.equal(result.lifecycle.rejections.byReason.ADMISSION_REQUIRED, 3)
    assert.doesNotMatch(JSON.stringify(result.lifecycle), /viewer:\d|session:|token/i)

    // 结构损坏 → 整节置 null
    const broken = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle: {
            ...lifecycle,
            rejections: { total: -1, byReason: {} },
        },
    })
    assert.equal(broken.lifecycle.rejections, null)
    assert.ok(broken.lifecycle.drift !== null)

    // 旧形状（无 drift/rejections 字段）→ 两节为 null
    const legacy = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle: {
            closingRooms: 1,
            closingOldestAgeMs: 0,
            sweptClosing: 0,
            lastSweptClosingAtMs: null,
            forcedDismissCloses: 0,
            lastForcedClose: null,
        },
    })
    assert.equal(legacy.lifecycle.drift, null)
    assert.equal(legacy.lifecycle.rejections, null)
})
