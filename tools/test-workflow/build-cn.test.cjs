const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "../..")
const orchestratorPath = path.join(__dirname, "build-cn.cjs")

function loadOrchestrator() {
    assert.equal(fs.existsSync(orchestratorPath), true, "CN build orchestrator must exist")
    return require(orchestratorPath)
}

function result(status, error = undefined) {
    return { error, signal: null, status }
}

function createHarness(statuses, {
    adminReady = true,
    npmExecutable = "/runtime/npm",
    platform = "darwin",
} = {}) {
    const calls = []
    const cleaned = []
    const removed = []
    const stderr = []
    return {
        calls,
        cleaned,
        dependencies: {
            cleanOrphanCompiledFiles: () => cleaned.push("cleaned"),
            executable: "/runtime/node",
            loadServerReleaseContract: () => ({ adminPath: "web/dist" }),
            npmExecutable,
            platform,
            projectRoot: "/project",
            verifyAdminBuild: () => adminReady,
            removeBuildInfo: filePath => removed.push(filePath),
            spawnSync: (executable, args, options) => {
                calls.push({ args, executable, options })
                const next = statuses.shift()
                return next && typeof next === "object" ? next : result(next)
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

function expectedAdminCall({ executable = "/runtime/npm", shell = false } = {}) {
    return {
        args: ["run", "build:admin"],
        executable,
        options: {
            cwd: "/project",
            shell,
            stdio: "inherit",
        },
    }
}

test("正常构建先完成 admin，再运行一次 tsc 和 verifier", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 0])

    assert.equal(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall, tscCall, verifierCall])
    assert.deepEqual(harness.cleaned, ["cleaned"])
    assert.deepEqual(harness.removed, [])
})

test("首次 verifier 失败时仅删除独立 build info 并完整重跑", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 1, 0, 0])

    assert.equal(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls, [adminCall, tscCall, verifierCall, tscCall, verifierCall])
    assert.deepEqual(harness.cleaned, ["cleaned", "cleaned"])
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

test("Windows 通过 shell 启动 npm.cmd，但 TypeScript 和 verifier 仍保持 shell:false", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([0, 0, 0], {
        npmExecutable: "npm.cmd",
        platform: "win32",
    })

    assert.equal(runCnBuild(harness.dependencies), 0)
    assert.deepEqual(harness.calls[0], expectedAdminCall({ executable: "npm.cmd", shell: true }))
    assert.equal(harness.calls[1].options.shell, false)
    assert.equal(harness.calls[2].options.shell, false)
})

test("spawnSync 启动错误会输出具体原因而不是静默返回 1", () => {
    const { runCnBuild } = loadOrchestrator()
    const harness = createHarness([
        result(null, Object.assign(new Error("spawnSync npm.cmd EINVAL"), { code: "EINVAL" })),
    ], { npmExecutable: "npm.cmd", platform: "win32" })

    assert.equal(runCnBuild(harness.dependencies), 1)
    assert.match(harness.stderr.join(""), /CN build admin process failed: spawnSync npm\.cmd EINVAL/)
})

test("同步构建把总上限传给子进程并在 timeout 后停止后续阶段", () => {
    const { runCnBuild } = loadOrchestrator()
    const timeout = Object.assign(new Error("build timed out"), { code: "ETIMEDOUT" })
    const harness = createHarness([result(null, timeout)])

    assert.equal(runCnBuild({ ...harness.dependencies, timeoutMs: 25 }), 1)
    assert.equal(harness.calls.length, 1)
    assert.equal(Number.isSafeInteger(harness.calls[0].options.timeout), true)
    assert.ok(harness.calls[0].options.timeout > 0)
    assert.ok(harness.calls[0].options.timeout <= 25)
    assert.match(harness.stderr.join(""), /CN build admin timed out/)
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

test("删除没有对应 TypeScript 源文件的过期编译输出及其 sidecar", t => {
    const { removeOrphanCompiledFiles } = loadOrchestrator()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-cn-orphans-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const sourceDirectory = path.join(root, "src")
    const outputDirectory = path.join(root, "out")
    fs.mkdirSync(path.join(sourceDirectory, "lib"), { recursive: true })
    fs.mkdirSync(path.join(outputDirectory, "lib"), { recursive: true })
    fs.writeFileSync(path.join(sourceDirectory, "lib", "current.ts"), "export const current = true\n")
    for (const relativePath of [
        "lib/current.js",
        "lib/current.js.map",
        "lib/orphan.js",
        "lib/orphan.js.map",
        "lib/orphan.d.ts",
        "lib/orphan.d.ts.map",
        ".tsbuildinfo-cn",
        "runtime.json",
    ]) {
        fs.writeFileSync(path.join(outputDirectory, relativePath), relativePath)
    }

    assert.deepEqual(removeOrphanCompiledFiles(sourceDirectory, outputDirectory), [
        "lib/orphan.d.ts",
        "lib/orphan.d.ts.map",
        "lib/orphan.js",
        "lib/orphan.js.map",
    ])
    assert.equal(fs.existsSync(path.join(outputDirectory, "lib", "current.js")), true)
    assert.equal(fs.existsSync(path.join(outputDirectory, ".tsbuildinfo-cn")), true)
    assert.equal(fs.existsSync(path.join(outputDirectory, "runtime.json")), true)
})
