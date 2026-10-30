"use strict"

// 切片 1 效果执行器 dry-run 回归（行为不变）：EFFECT_INVENTORY 完整性、
// decision.effects 记账（拒绝不记）、hostReturn 相位守卫（battle 外跳过、
// battle 内派发、无条目 no-op）、admin status 消毒。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { lifecycleRegistry } = require("../src/multi/lifecycle")
const {
    EFFECT_INVENTORY,
    recordEffectsDryRun,
    getEffectDryRunStatus,
    resetEffectDryRunForTest,
} = require("../src/multi/lifecycle/effect-executor")
const { buildAdminMultiStatus } = require("../src/lib/admin-multi-status")

function fresh() {
    resetEffectDryRunForTest()
    lifecycleRegistry.reset()
}

function dispatch(roomNumber, build) {
    const decision = lifecycleRegistry.dispatch(roomNumber, build)
    assert.ok(decision, `no lifecycle state for room ${roomNumber}`)
    return decision
}

test("EFFECT_INVENTORY covers all nine effects, all pending, sites documented", () => {
    assert.deepEqual(
        EFFECT_INVENTORY.map(entry => entry.effect).sort(),
        [
            "broadcastMates",
            "closeRecruitment",
            "closeRoom",
            "persistBattleRelease",
            "releaseSeats",
            "scheduleGc",
            "sendDismiss",
            "sendEnterReply",
            "updateShareRow",
        ],
    )
    for (const entry of EFFECT_INVENTORY) {
        assert.equal(entry.state, "pending", entry.effect)
        assert.ok(entry.handWrittenSites.length >= 1, entry.effect)
        for (const site of entry.handWrittenSites) {
            assert.equal(typeof site, "string")
            assert.ok(site.length > 0 && site.length <= 160, entry.effect)
        }
    }
})

test("dry-run records effect totals for accepted decisions only", () => {
    fresh()
    lifecycleRegistry.create("123456", "viewer:1")
    const decision = dispatch("123456", generation => ({
        type: "enter",
        generation,
        identity: "viewer:1",
        nowMs: 1_000,
    }))
    assert.equal(decision.rejected, undefined)
    const status = getEffectDryRunStatus()
    assert.equal(status.mode, "dry-run")
    assert.equal(status.events, 1)
    assert.equal(status.totals.sendEnterReply, 1)
    assert.equal(status.totals.broadcastMates, 1)
    assert.equal(status.totals.updateShareRow, 1)
    assert.ok(status.lastEventAtMs !== null)
    assert.deepEqual(status.lastEvent, {
        roomNumber: "123456",
        event: "enter",
        effects: ["sendEnterReply", "broadcastMates", "updateShareRow"],
    })

    // 房主未入座方的 ready 被拒绝：不记账
    dispatch("123456", generation => ({
        type: "ready",
        generation,
        identity: "viewer:99",
        ready: true,
    }))
    assert.equal(getEffectDryRunStatus().events, 1)
})

test("dry-run aggregates repeated effects across events (disband batch)", () => {
    fresh()
    lifecycleRegistry.create("234567", "viewer:1")
    dispatch("234567", generation => ({
        type: "admit", generation, identity: "viewer:2",
    }))
    dispatch("234567", generation => ({
        type: "handshake", generation, identity: "viewer:2",
    }))
    dispatch("234567", generation => ({
        type: "enter", generation, identity: "viewer:2", nowMs: 1_000,
    }))
    dispatch("234567", generation => ({
        type: "enter", generation, identity: "viewer:1", nowMs: 1_100,
    }))
    const disband = dispatch("234567", generation => ({
        type: "disband", generation, identity: "viewer:1", nowMs: 2_000, closeDeadlineMs: 300_000,
    }))
    assert.equal(disband.rejected, undefined)
    const status = getEffectDryRunStatus()
    assert.equal(status.totals.sendEnterReply, 2)
    // enterClosing：每人一条 dismiss + 关招募 + 广播 + share 行 + scheduleGc
    assert.equal(status.totals.sendDismiss, 2)
    assert.equal(status.totals.closeRecruitment, 1)
    assert.equal(status.totals.broadcastMates, 3)
    assert.equal(status.totals.updateShareRow, 3)
    assert.equal(status.totals.scheduleGc, 1)
    assert.deepEqual([...status.lastEvent.effects].sort(), [
        "broadcastMates", "closeRecruitment", "scheduleGc", "sendDismiss", "updateShareRow",
    ])
})

test("hostReturn guard dispatches only in battle phase and is a no-op without entry", () => {
    fresh()
    // 无条目：no-op（与旧行为逐字节等价——dispatch 对无条目返回 null）
    lifecycleRegistry.dispatchHostReturnIfInBattle("999999", "viewer:1")
    assert.equal(lifecycleRegistry.stats().rejections, 0)

    lifecycleRegistry.create("345678", "viewer:1")
    // recruiting 相位：跳过（旧行为=内核拒绝 NOT_IN_BATTLE，无 effect）
    lifecycleRegistry.dispatchHostReturnIfInBattle("345678", "viewer:1")
    assert.equal(lifecycleRegistry.stats().rejections, 0)
    assert.equal(getEffectDryRunStatus().events, 0)

    // 进入 battle：guest 走完 admit→handshake→enter 上座，房主首次 enter 使
    // recruiting→ready，再 startBattle（battleParticipants = 当时全部座位）
    dispatch("345678", generation => ({ type: "admit", generation, identity: "viewer:2" }))
    dispatch("345678", generation => ({ type: "handshake", generation, identity: "viewer:2" }))
    dispatch("345678", generation => ({ type: "enter", generation, identity: "viewer:2", nowMs: 900 }))
    dispatch("345678", generation => ({ type: "enter", generation, identity: "viewer:1", nowMs: 1_000 }))
    dispatch("345678", generation => ({ type: "ready", generation, identity: "viewer:1", ready: true }))
    dispatch("345678", generation => ({
        type: "startBattle", generation, identity: "viewer:1", battleSessionId: "b1",
    }))
    lifecycleRegistry.dispatchHostReturnIfInBattle("345678", "viewer:1")
    let state = lifecycleRegistry.get("345678")
    assert.deepEqual(state.hostReturnPending, true)
    assert.equal(lifecycleRegistry.stats().rejections, 0)

    // 宿主提前返回后最后一个 finish 直接 4→1；之后的重复守卫派发是 no-op
    dispatch("345678", generation => ({
        type: "finish", generation, identity: "viewer:2",
        nowMs: 2_000, battleDeadlineMs: 900_000, battleSessionId: "b1",
    }))
    const finalDecision = dispatch("345678", generation => ({
        type: "finish", generation, identity: "viewer:1",
        nowMs: 2_100, battleDeadlineMs: 900_000, battleSessionId: "b1",
    }))
    assert.equal(finalDecision.rejected, undefined)
    assert.equal(finalDecision.state.phase, "ready")
    lifecycleRegistry.dispatchHostReturnIfInBattle("345678", "viewer:1")
    assert.equal(lifecycleRegistry.get("345678").phase, "ready")
    assert.equal(lifecycleRegistry.stats().rejections, 0)
})

test("admin status sanitizes effectDryRun and tolerates legacy shapes", () => {
    fresh()
    const runtime = {
        mode: "host",
        state: "ready",
        coordinator: { kind: "local", available: true },
        hub: null,
        tcp: { available: true, endpoint: "127.0.0.1:8003" },
    }
    const valid = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle: {
            closingRooms: 0,
            closingOldestAgeMs: 0,
            sweptClosing: 0,
            lastSweptClosingAtMs: null,
            forcedDismissCloses: 0,
            lastForcedClose: null,
            effectDryRun: {
                mode: "dry-run",
                events: 3,
                totals: { sendEnterReply: 2, broadcastMates: 3 },
                lastEventAtMs: 9_000,
                lastEvent: { roomNumber: "123456", event: "enter", effects: ["sendEnterReply", "broadcastMates"] },
            },
        },
    })
    assert.equal(valid.lifecycle.effectDryRun.events, 3)
    assert.deepEqual(valid.lifecycle.effectDryRun.totals, { sendEnterReply: 2, broadcastMates: 3 })
    assert.deepEqual(valid.lifecycle.effectDryRun.lastEvent.effects, ["sendEnterReply", "broadcastMates"])

    // 结构损坏 → null
    const broken = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle: {
            closingRooms: 0,
            closingOldestAgeMs: 0,
            sweptClosing: 0,
            lastSweptClosingAtMs: null,
            forcedDismissCloses: 0,
            lastForcedClose: null,
            effectDryRun: { mode: "switched", events: 1, totals: {}, lastEventAtMs: null, lastEvent: null },
        },
    })
    assert.equal(broken.lifecycle.effectDryRun, null)

    // 旧形状（无该字段）→ null
    const legacy = buildAdminMultiStatus({
        runtime,
        authority: null,
        latestCompatibilityRejection: null,
        lifecycle: {
            closingRooms: 0,
            closingOldestAgeMs: 0,
            sweptClosing: 0,
            lastSweptClosingAtMs: null,
            forcedDismissCloses: 0,
            lastForcedClose: null,
        },
    })
    assert.equal(legacy.lifecycle.effectDryRun, null)
})
