"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { test } = require("node:test")

const {
    registerCleanupTask,
    recordCleanupRun,
    startCleanupScheduler,
    stopCleanupScheduler,
    getCleanupSchedulerStatus,
    resetCleanupSchedulerForTest,
} = require("../src/multi/lifecycle/cleanup-scheduler")

test("scheduler-driven tasks fire on their own interval under the master tick", () => {
    resetCleanupSchedulerForTest()
    let runs = 0
    registerCleanupTask({ name: "tick-a", intervalMs: 60_000, task: () => { runs += 1 } })
    registerCleanupTask({ name: "tick-b", intervalMs: 120_000, task: () => {} })
    startCleanupScheduler(60_000)
    // 主 tick 间隔本身不由测试驱动——直接走 record/状态语义由 external 用例覆盖
    const status = getCleanupSchedulerStatus()
    assert.equal(status.running, true)
    assert.equal(status.tasks.length, 2)
    assert.equal(status.tasks[0].mode, "scheduler")
    stopCleanupScheduler()
    assert.equal(getCleanupSchedulerStatus().running, false)
    assert.equal(runs, 0)
})

test("externally-driven tasks report runs and failures without a master tick", () => {
    resetCleanupSchedulerForTest()
    registerCleanupTask({ name: "roomCleanup", intervalMs: 60_000, externallyDriven: true })
    recordCleanupRun("roomCleanup", 1_000)
    recordCleanupRun("roomCleanup", 2_000, "boom")
    const status = getCleanupSchedulerStatus()
    assert.equal(status.tasks[0].mode, "external")
    assert.equal(status.tasks[0].runCount, 2)
    assert.equal(status.tasks[0].lastRunAtMs, 2_000)
    assert.equal(status.tasks[0].lastError, "boom")

    // 未注册任务的上报静默忽略
    recordCleanupRun("unregistered", 3_000)
    assert.equal(status.tasks.length, getCleanupSchedulerStatus().tasks.length)
})

test("excluded entries register with a reason and carry no interval", () => {
    resetCleanupSchedulerForTest()
    registerCleanupTask({ name: "hubIdempotencyCache", intervalMs: 0, excludedReason: "hub-side" })
    const status = getCleanupSchedulerStatus()
    assert.equal(status.tasks[0].mode, "excluded")
    assert.equal(status.tasks[0].intervalMs, null)
})

test("registrations validate name, interval and callback", () => {
    resetCleanupSchedulerForTest()
    assert.throws(() => registerCleanupTask({ name: "", intervalMs: 1_000, task: () => {} }), TypeError)
    assert.throws(() => registerCleanupTask({ name: "x".repeat(65), intervalMs: 1_000, task: () => {} }), TypeError)
    assert.throws(() => registerCleanupTask({ name: "bad-interval", intervalMs: 0, task: () => {} }), TypeError)
    assert.throws(() => registerCleanupTask({ name: "no-callback", intervalMs: 1_000 }), TypeError)
})

test("scheduler-driven licensing math and error capture (core loop)", () => {
    resetCleanupSchedulerForTest()
    let runs = 0
    let boom = 0
    registerCleanupTask({ name: "lic-a", intervalMs: 60_000, task: () => { runs += 1 } })
    registerCleanupTask({ name: "lic-b", intervalMs: 120_000, task: () => { throw new Error("boom-b") } })
    const { runSchedulerDrivenTasksForTest } = require("../src/multi/lifecycle/cleanup-scheduler")
    runSchedulerDrivenTasksForTest(0)
    assert.equal(runs, 1, "first tick fires both")
    runSchedulerDrivenTasksForTest(59_999)
    assert.equal(runs, 1, "before interval: not re-licensed")
    runSchedulerDrivenTasksForTest(60_000)
    assert.equal(runs, 2, "at interval: re-licensed")
    const status = getCleanupSchedulerStatus()
    const boomTask = status.tasks.find(task => task.name === "lic-b")
    assert.equal(boomTask.lastError, "boom-b")
    assert.ok(boomTask.lastErrorAtMs !== null)
    resetCleanupSchedulerForTest()
})
