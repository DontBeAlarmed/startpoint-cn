"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const entryPath = path.join(projectRoot, "src/content/sync/entry.ts")

function loadEntry() {
    assert.equal(fs.existsSync(entryPath), true, "compiled content sync entry must be implemented")
    return require(entryPath)
}

for (const expectedCode of [0, 1]) {
    test(`CLI 持有 ${expectedCode} 退出码，入口只透传且不重复设置`, async () => {
        const { runContentSyncEntry } = loadEntry()
        const argv = ["--check"]
        const env = { CONTENT_SYNC_ENTRY_TEST: "1" }
        const stdout = { write() {} }
        const stderr = { write() {} }
        const exitCodes = []
        const calls = []
        const setExitCode = code => { exitCodes.push(code) }

        const result = await runContentSyncEntry(argv, {
            env,
            stdout,
            stderr,
            setExitCode,
            runCli: async (receivedArgv, dependencies) => {
                calls.push({ receivedArgv, dependencies })
                dependencies.setExitCode(expectedCode)
                return expectedCode
            },
        })

        assert.equal(result, expectedCode)
        assert.deepEqual(exitCodes, [expectedCode])
        assert.equal(calls.length, 1)
        assert.equal(calls[0].receivedArgv, argv)
        assert.equal(calls[0].dependencies.env, env)
        assert.equal(calls[0].dependencies.stdout, stdout)
        assert.equal(calls[0].dependencies.stderr, stderr)
        assert.equal(calls[0].dependencies.setExitCode, setExitCode)
    })
}

test("CLI 拒绝时由入口设置一次兜底退出码且不泄露路径", async () => {
    const { runContentSyncEntry } = loadEntry()
    const secretPath = "/private/sensitive/content/catalog.json"
    let stderr = ""
    const exitCodes = []

    const result = await runContentSyncEntry([], {
        runCli: async () => { throw new Error(`failed to initialize ${secretPath}`) },
        stderr: { write: value => { stderr += value } },
        setExitCode: code => { exitCodes.push(code) },
    })

    assert.equal(result, 1)
    assert.deepEqual(exitCodes, [1])
    assert.equal(stderr, "错误 [CONTENT_SYNC_ENTRY_FAILED]：内容同步入口初始化失败\n")
    assert.doesNotMatch(stderr, /private|sensitive|catalog\.json/)
})

test("CN build verifier 要求 compiled content sync entry 及正确导出", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "content-sync-entry-build-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    const createFile = (relativePath, contents = "") => {
        const filePath = path.join(outputDirectory, relativePath)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, contents)
    }
    for (const relativePath of [
        "cn-server.js",
        "server.js",
        "multi/tcp/lobby.js",
        "multi/npc/controller.js",
    ]) {
        createFile(relativePath)
    }
    createFile(
        "content/startup/bootstrap.js",
        "module.exports = { runContentStartup() {} }\n",
    )
    const { verifyBuild } = require("./test-workflow/verify-cn-build.cjs")

    assert.deepEqual(verifyBuild(outputDirectory), ["content/sync/entry.js"])

    createFile("content/sync/entry.js", "module.exports = {}\n")
    assert.deepEqual(verifyBuild(outputDirectory), ["content/sync/entry.js"])

    createFile(
        "content/sync/entry.js",
        "module.exports = { runContentSyncEntry() {} }\n",
    )
    assert.deepEqual(verifyBuild(outputDirectory), [])
})
