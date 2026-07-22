const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const bootstrapPath = path.join(projectRoot, "src/content/startup/bootstrap.ts")

function loadBootstrap() {
    assert.equal(
        fs.existsSync(bootstrapPath),
        true,
        "startup bootstrap must be implemented",
    )
    return require(bootstrapPath)
}

class FakeChild extends EventEmitter {
    constructor() {
        super()
        this.killCalls = []
    }

    kill(signal) {
        this.killCalls.push(signal)
        return true
    }
}

function createHarness(options = {}) {
    const calls = []
    const children = []
    const processTarget = options.processTarget ?? new EventEmitter()
    const stderr = []
    const spawn = (executable, args, spawnOptions) => {
        const call = { executable, args, options: spawnOptions }
        calls.push(call)
        if (options.throwAt === calls.length) {
            throw new Error(`/sensitive/project failed at ${args[0]}`)
        }
        const child = new FakeChild()
        children.push(child)
        options.onSpawn?.({ child, processTarget, calls })
        return child
    }
    return {
        calls,
        children,
        dependencies: {
            projectRoot,
            executable: "/fixed/node",
            env: { CONTENT_STARTUP_TEST: "1" },
            processTarget,
            spawn,
            stderr: { write: chunk => stderr.push(String(chunk)) },
        },
        processTarget,
        stderr,
    }
}

function assertSignalListenersRemoved(processTarget) {
    assert.equal(processTarget.listenerCount("SIGINT"), 0)
    assert.equal(processTarget.listenerCount("SIGTERM"), 0)
}

async function finishSync(harness, code = 0, signal = null) {
    harness.children[0].emit("close", code, signal)
    await Promise.resolve()
}

for (const releaseState of ["版本未变化", "版本已变化并激活 Release"]) {
    test(`${releaseState}时均按 sync、server 顺序启动`, async () => {
        const { runContentStartup } = loadBootstrap()
        const harness = createHarness()

        const running = runContentStartup(harness.dependencies)
        assert.equal(harness.calls.length, 1)
        assert.equal(path.basename(harness.calls[0].args[0]), "content_sync.cjs")

        await finishSync(harness)
        assert.equal(harness.calls.length, 2)
        assert.equal(path.basename(harness.calls[1].args[0]), "cn-server.js")
        harness.children[1].emit("close", 0, null)

        assert.deepEqual(await running, { code: 0, signal: null })
    })
}

test("显式 local 与默认模式一样先 sync 再启动 server", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()
    harness.dependencies.env = { ASSET_MODE: "local" }

    const running = runContentStartup(harness.dependencies)
    assert.equal(path.basename(harness.calls[0].args[0]), "content_sync.cjs")
    await finishSync(harness)
    assert.equal(path.basename(harness.calls[1].args[0]), "cn-server.js")
    harness.children[1].emit("close", 0, null)
    assert.deepEqual(await running, { code: 0, signal: null })
})

for (const mode of ["remote", "client-owned"]) {
    test(`${mode} 直接启动 server 且不触碰本地 CDN 配置`, async () => {
        const { runContentStartup } = loadBootstrap()
        const harness = createHarness()
        harness.dependencies.env = mode === "remote"
            ? {
                ASSET_MODE: mode,
                CDN_BASE_URL: "https://cdn.example.test/patch/cn",
                CDN_DIR: "must-be-ignored/cn",
            }
            : {
                ASSET_MODE: mode,
                CDN_BASE_URL: "not a URL",
                CDN_DIR: "must-be-ignored/cn",
            }

        const running = runContentStartup(harness.dependencies)
        assert.equal(harness.calls.length, 1)
        assert.equal(path.basename(harness.calls[0].args[0]), "cn-server.js")
        harness.children[0].emit("close", 0, null)

        assert.deepEqual(await running, { code: 0, signal: null })
        assert.equal(harness.calls.length, 1)
    })
}

test("sync 非零退出时不启动 server 并透传退出码", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()

    const running = runContentStartup(harness.dependencies)
    harness.children[0].emit("close", 23, null)

    assert.deepEqual(await running, { code: 23, signal: null })
    assert.equal(harness.calls.length, 1)
})

test("sync 被信号终止时不启动 server 并透传信号", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()

    const running = runContentStartup(harness.dependencies)
    harness.children[0].emit("close", null, "SIGTERM")

    assert.deepEqual(await running, { code: null, signal: "SIGTERM" })
    assert.equal(harness.calls.length, 1)
})

test("sync spawn 失败时不启动 server，返回稳定非零码且不泄露路径", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness({ throwAt: 1 })

    assert.deepEqual(
        await runContentStartup(harness.dependencies),
        { code: 1, signal: null },
    )
    assert.equal(harness.calls.length, 1)
    assert.doesNotMatch(harness.stderr.join(""), /\/sensitive\/project/)
})

test("server 的退出码和终止信号语义均透传", async t => {
    const { runContentStartup } = loadBootstrap()
    await t.test("退出码", async () => {
        const harness = createHarness()
        const running = runContentStartup(harness.dependencies)
        await finishSync(harness)
        harness.children[1].emit("close", 9, null)
        assert.deepEqual(await running, { code: 9, signal: null })
    })
    await t.test("终止信号", async () => {
        const harness = createHarness()
        const running = runContentStartup(harness.dependencies)
        await finishSync(harness)
        harness.children[1].emit("close", null, "SIGINT")
        assert.deepEqual(await running, { code: null, signal: "SIGINT" })
    })
    await t.test("spawn 失败", async () => {
        const harness = createHarness({ throwAt: 2 })
        const running = runContentStartup(harness.dependencies)
        await finishSync(harness)
        assert.deepEqual(await running, { code: 1, signal: null })
        assert.equal(harness.calls.length, 2)
    })
})

for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`${signal} 在 sync 阶段只转发一次且不启动 server`, async () => {
        const { runContentStartup } = loadBootstrap()
        const harness = createHarness()
        const running = runContentStartup(harness.dependencies)

        harness.processTarget.emit(signal)
        harness.processTarget.emit(signal)
        harness.processTarget.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT")
        assert.deepEqual(harness.children[0].killCalls, [signal])
        harness.children[0].emit("close", 0, null)

        assert.deepEqual(await running, { code: 0, signal: null })
        assert.equal(harness.calls.length, 1)
    })

    test(`${signal} 在 server 阶段只转发一次`, async () => {
        const { runContentStartup } = loadBootstrap()
        const harness = createHarness()
        const running = runContentStartup(harness.dependencies)
        await finishSync(harness)

        harness.processTarget.emit(signal)
        harness.processTarget.emit(signal)
        assert.deepEqual(harness.children[1].killCalls, [signal])
        harness.children[1].emit("close", 0, null)

        assert.deepEqual(await running, { code: 0, signal: null })
        assert.match(harness.stderr.join(""), /\[startup\] CN server exited cleanly/)
        assert.equal(harness.calls.length, 2)
    })
}

test("首阶段 spawn 前已关停时不创建子进程", async () => {
    const { runContentStartup } = loadBootstrap()
    class SignalOnRegistration extends EventEmitter {
        on(event, listener) {
            super.on(event, listener)
            if (event === "SIGINT") this.emit("SIGINT")
            return this
        }
    }
    const processTarget = new SignalOnRegistration()
    const harness = createHarness({ processTarget })

    const running = runContentStartup(harness.dependencies)
    harness.children[0]?.emit("close", 0, null)

    assert.deepEqual(await running, { code: null, signal: "SIGINT" })
    assert.equal(harness.calls.length, 0)
    assertSignalListenersRemoved(processTarget)
})

test("信号在 spawn 回调期间到达时绑定后只 kill 新子进程一次", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness({
        onSpawn: ({ processTarget }) => {
            processTarget.emit("SIGTERM")
            processTarget.emit("SIGTERM")
            processTarget.emit("SIGINT")
        },
    })

    const running = runContentStartup(harness.dependencies)
    harness.children[0].emit("close", 0, null)

    assert.deepEqual(await running, { code: 0, signal: null })
    assert.equal(harness.calls.length, 1)
    assert.deepEqual(harness.children[0].killCalls, ["SIGTERM"])
    assertSignalListenersRemoved(harness.processTarget)
})

test("sync close 与 server spawn 之间收到信号时不启动 server", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()
    const running = runContentStartup(harness.dependencies)
    harness.children[0].on("close", () => {
        harness.processTarget.emit("SIGINT")
        harness.processTarget.emit("SIGTERM")
    })

    harness.children[0].emit("close", 0, null)

    assert.deepEqual(await running, { code: 0, signal: null })
    assert.equal(harness.calls.length, 1)
    assert.deepEqual(harness.children[0].killCalls, ["SIGINT"])
    assertSignalListenersRemoved(harness.processTarget)
})

test("async error 后立即收到信号时不启动 server 且 kill 幂等", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()
    const running = runContentStartup(harness.dependencies)
    harness.children[0].on("error", () => {
        harness.processTarget.emit("SIGTERM")
        harness.processTarget.emit("SIGTERM")
        harness.processTarget.emit("SIGINT")
    })

    harness.children[0].emit("error", new Error("spawn failed"))

    assert.deepEqual(await running, { code: 1, signal: null })
    assert.equal(harness.calls.length, 1)
    assert.deepEqual(harness.children[0].killCalls, ["SIGTERM"])
    assertSignalListenersRemoved(harness.processTarget)
})

test("固定使用仓库入口、调用者 cwd 和参数不能注入 shell 命令", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()
    const originalCwd = process.cwd()
    const hostileDirectory = path.dirname(projectRoot)

    try {
        process.chdir(hostileDirectory)
        const running = runContentStartup(harness.dependencies)
        await finishSync(harness)
        harness.children[1].emit("close", 0, null)
        await running
    } finally {
        process.chdir(originalCwd)
    }

    assert.deepEqual(
        harness.calls.map(call => [call.executable, call.args, call.options]),
        [
            ["/fixed/node", [path.join(projectRoot, "tools/content_sync.cjs")], {
                cwd: projectRoot,
                env: harness.dependencies.env,
                shell: false,
                stdio: "inherit",
            }],
            ["/fixed/node", [path.join(projectRoot, "out/cn-server.js")], {
                cwd: projectRoot,
                env: harness.dependencies.env,
                shell: false,
                stdio: "inherit",
            }],
        ],
    )
})

test("正式入口、测试组和 tracked 中文文档声明与 bootstrap 一致", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
    const groups = require("./test-workflow/groups.cjs").TEST_GROUPS
    const shellScript = fs.readFileSync(path.join(projectRoot, "scripts/start-cn.sh"), "utf8")
    const lowLevelSource = fs.readFileSync(path.join(projectRoot, "src/cn-server.ts"), "utf8")
    const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8")
    const docsReadme = fs.readFileSync(path.join(projectRoot, "docs/README.md"), "utf8")
    const deployment = fs.readFileSync(path.join(projectRoot, "docs/deployment.md"), "utf8")
    const cdnDebugging = fs.readFileSync(path.join(projectRoot, "docs/cdn/debugging.md"), "utf8")

    assert.equal(packageJson.scripts["start:cn"], "node tools/start_cn.cjs")
    assert.equal(
        packageJson.scripts["dev:cn"],
        "npm run build:server && node tools/start_cn.cjs",
    )
    assert.ok(groups["quick:content"].tests.includes("tools/content_startup.test.cjs"))
    assert.match(shellScript, /npm run build:server/)
    assert.match(shellScript, /tools\/start_cn\.cjs/)
    assert.match(shellScript, /exec node tools\/start_cn\.cjs/)
    assert.doesNotMatch(shellScript, /nohup|pkill|pgrep|admin|vite/i)
    assert.doesNotMatch(lowLevelSource, /content\/startup|content:sync|content_sync/)
    assert.match(readme, /content:sync/)
    assert.match(readme, /node out\/cn-server\.js[^\n]*不会自动同步/)
    assert.match(docsReadme, /前台[^\n]*bootstrap/)
    assert.match(deployment, /后台运行[^\n]*进程管理器/)
    assert.doesNotMatch(deployment, /\/tmp\/cn-server\.log|nohup|pkill/)
    assert.match(cdnDebugging, /常规启动[^\n]*bootstrap/)
    assert.match(cdnDebugging, /node out\/cn-server\.js[^\n]*低级调试入口/)
    assert.doesNotMatch(cdnDebugging, /node --env-file=\.env out\/cn-server\.js[^\n]*&/)
})

test("start_cn 工具允许缺少 .env，且只从仓库固定位置加载 bootstrap", async () => {
    const toolPath = path.join(projectRoot, "tools/start_cn.cjs")
    assert.equal(fs.existsSync(toolPath), true, "start_cn tool must be implemented")
    const { loadOptionalProjectEnv, runStartCn } = require(toolPath)
    assert.equal(loadOptionalProjectEnv(projectRoot, { existsSync: () => false }), false)

    const loaded = []
    const outcomes = []
    const originalCwd = process.cwd()
    try {
        process.chdir(path.dirname(projectRoot))
        await runStartCn({
            argv: ["node", toolPath, "; rm -rf ignored"],
            loadEnv: () => false,
            loadBootstrap: modulePath => {
                loaded.push(modulePath)
                return { runContentStartup: async dependencies => {
                    outcomes.push(dependencies)
                    return { code: 0, signal: null }
                } }
            },
            applyOutcome: () => {},
        })
    } finally {
        process.chdir(originalCwd)
    }

    assert.deepEqual(loaded, [path.join(projectRoot, "out/content/startup/bootstrap.js")])
    assert.deepEqual(outcomes, [{ projectRoot }])
})

test("异步 spawn error 稳定失败且不会进入下一阶段", async () => {
    const { runContentStartup } = loadBootstrap()
    const harness = createHarness()
    const running = runContentStartup(harness.dependencies)

    harness.children[0].emit("error", new Error("/sensitive/project/spawn error"))

    assert.deepEqual(await running, { code: 1, signal: null })
    assert.equal(harness.calls.length, 1)
    assert.doesNotMatch(harness.stderr.join(""), /\/sensitive\/project/)
})

test("start_cn 将退出码或信号应用到父进程", () => {
    const { applyStartupOutcome } = require(path.join(projectRoot, "tools/start_cn.cjs"))
    const exitCodes = []
    const signals = []

    applyStartupOutcome(
        { code: 17, signal: null },
        { setExitCode: code => exitCodes.push(code) },
    )
    applyStartupOutcome(
        { code: null, signal: "SIGTERM" },
        { signalSelf: signal => signals.push(signal) },
    )

    assert.deepEqual(exitCodes, [17])
    assert.deepEqual(signals, ["SIGTERM"])
})
