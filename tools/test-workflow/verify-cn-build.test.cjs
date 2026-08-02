const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const verifier = path.resolve(__dirname, "verify-cn-build.cjs")
const requiredFiles = [
    "cn-server.js",
    "server.js",
    "content/sync/entry.js",
    "content/startup/bootstrap.js",
    "multi/tcp/lobby.js",
    "multi/npc/controller.js",
]

function createFile(root, relativePath, contents = "") {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
}

function createRuntimeFiles(outputDirectory, bootstrapContents) {
    for (const relativePath of requiredFiles) {
        let contents = ""
        if (relativePath === "content/startup/bootstrap.js") contents = bootstrapContents
        if (relativePath === "content/sync/entry.js") {
            contents = "module.exports = { runContentSyncEntry() {} }\n"
        }
        createFile(outputDirectory, relativePath, contents)
    }
}

test("fails and lists every missing CN runtime module", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-missing-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(result.stderr, /cn-server\.js/)
    assert.match(result.stderr, /^\s+- server\.js$/m)
    assert.match(result.stderr, /content\/startup\/bootstrap\.js/)
    assert.match(result.stderr, /multi\/tcp\/lobby\.js/)
    assert.match(result.stderr, /multi\/npc\/controller\.js/)
})

test("fails when the global server entrypoint is missing", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-global-build-missing-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    fs.rmSync(path.join(outputDirectory, "server.js"))

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /^\s+- server\.js$/m)
})

test("accepts a complete default out directory", t => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-complete-"))
    t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        path.join(projectDirectory, "out"),
        "module.exports = { runContentStartup() {} }\n",
    )

    const result = spawnSync(process.execPath, [verifier], {
        cwd: projectDirectory,
        encoding: "utf8",
    })

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, new RegExp(projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("rejects a runtime module that writes the marker to stdout and exits zero", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-exit-zero-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    createFile(
        outputDirectory,
        "content/sync/entry.js",
        "process.stdout.write(Buffer.from([1])); process.exit(0)\n",
    )

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /content\/sync\/entry\.js/)
    assert.doesNotMatch(result.stderr, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("rejects a runtime module that throws while loading", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-throw-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    createFile(
        outputDirectory,
        "content/sync/entry.js",
        "throw new Error('failed to load runtime module')\n",
    )

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /content\/sync\/entry\.js/)
    assert.doesNotMatch(result.stderr, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("accepts a correct export without forwarding ordinary module output", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-module-output-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    createFile(
        outputDirectory,
        "content/sync/entry.js",
        "process.stdout.write('ordinary module output\\n')\n"
            + "module.exports = { runContentSyncEntry() {} }\n",
    )

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "CN build verified\n")
})

test("rejects extra bytes on the completion channel", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-extra-marker-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    createFile(
        outputDirectory,
        "content/sync/entry.js",
        "require('node:fs').writeSync(3, Buffer.from([1]))\n"
            + "module.exports = { runContentSyncEntry() {} }\n",
    )

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /content\/sync\/entry\.js/)
})

test("force-kills an export probe that handles SIGTERM and treats it as invalid", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-timeout-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
    createRuntimeFiles(
        outputDirectory,
        "module.exports = { runContentStartup() {} }\n",
    )
    createFile(
        outputDirectory,
        "content/sync/entry.js",
        "process.on('SIGTERM', () => {})\n"
            + "setTimeout(() => process.exit(0), 4000)\n"
            + "module.exports = { runContentSyncEntry() {} }\n",
    )

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
        timeout: 2_500,
        killSignal: "SIGKILL",
    })

    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /content\/sync\/entry\.js/)
})

for (const [name, bootstrapContents] of [
    ["空 bootstrap", ""],
    ["无 runContentStartup 导出的旧 bootstrap", "module.exports = {}\n"],
]) {
    test(`${name} 不能通过 CN build verifier`, t => {
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-invalid-"))
        t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))
        createRuntimeFiles(outputDirectory, bootstrapContents)

        const result = spawnSync(process.execPath, [verifier, outputDirectory], {
            encoding: "utf8",
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /content\/startup\/bootstrap\.js/)
        assert.doesNotMatch(result.stderr, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    })
}
