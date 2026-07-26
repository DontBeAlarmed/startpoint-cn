const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "../..")
const orchestratorPath = path.join(__dirname, "build-cn.cjs")

function loadOrchestrator() {
    assert.equal(fs.existsSync(orchestratorPath), true, "CN build orchestrator must exist")
    return require(orchestratorPath)
}

function result(status) {
    return { error: undefined, signal: null, status }
}

function createHarness(statuses, { adminReady = true } = {}) {
    const calls = []
    const removed = []
    const stderr = []
    return {
        calls,
        dependencies: {
            executable: "/runtime/node",
            npmExecutable: "/runtime/npm",
            projectRoot: "/project",
            verifyAdminBuild: () => adminReady,
            removeBuildInfo: filePath => removed.push(filePath),
            spawnSync: (executable, args, options) => {
                calls.push({ args, executable, options })
                return result(statuses.shift())
            },
            stderr: { write: chunk => stderr.push(String(chunk)) },
        },
        removed,
        stderr,
    }
}

function expectedCall(entry, args = []) {
    return {
        args: [entry, ...args],
        executable: "/runtime/node",
        options: {
            cwd: "/project",
            shell: false,
            stdio: "inherit",
        },
    }
}

const tscCall = expectedCall("--max-old-space-size=4096", [
    "/project/node_modules/typescript/bin/tsc",
    "-p",
    "/project/tsconfig.cn.json",
])
const verifierCall = expectedCall("/project/tools/test-workflow/verify-cn-build.cjs", [
    "/project/out",
])
const adminCall = {
    args: ["run", "build:admin"],
    executable: "/runtime/npm",
    options: {
        cwd: "/project",
        shell: false,
        stdio: "inherit",
    },
}

test("正常构建先完成 admin，再运行一次 tsc 和 verifier", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 0])

    assert.equal(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall, tscCall, verifierCall])
    assert.deepEqual(harness.removed, [])
})

test("首次 verifier 失败时仅删除独立 build info 并完整重跑", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 1, 0, 0])

    assert.equal(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall, tscCall, verifierCall, tscCall, verifierCall])
    assert.deepEqual(harness.removed, ["/project/out/.tsbuildinfo-cn"])
    assert.doesNotMatch(harness.stderr.join(""), /\/project/)
})

test("admin 构建失败时不运行 tsc、verifier 或恢复轮次", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([2])

    assert.equal(runCnBuild(harness.dependencies), 2)
    assert.deepEqual(harness.calls, [adminCall])
    assert.deepEqual(harness.removed, [])
})

test("admin 构建未生成 index.html 时整体失败", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0], { adminReady: false })

    assert.notEqual(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall])
    assert.match(harness.stderr.join(""), /admin/i)
})

test("首次 tsc 失败时不运行 verifier 或恢复轮次", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 2])

    assert.equal(runCnBuild(harness.dependencies), 2)
    assert.deepEqual(harness.calls, [adminCall, tscCall])
    assert.deepEqual(harness.removed, [])
})

test("恢复后的 verifier 仍失败时返回非零", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 1, 0, 1])

    assert.notEqual(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall, tscCall, verifierCall, tscCall, verifierCall])
    assert.deepEqual(harness.removed, ["/project/out/.tsbuildinfo-cn"])
})

test("默认项目根路径由 orchestrator 位置决定", () => {
    const { runCnBuild } = loadOrchestrator()
    const calls = []

    assert.equal(runCnBuild({
        verifyAdminBuild: () => true,
        spawnSync: (executable, args, options) => {
            calls.push({ args, executable, options })
            return result(0)
        },
    }), 0)
    assert.equal(calls[0].options.cwd, projectRoot)
    assert.equal(calls[1].executable, process.execPath)
})
