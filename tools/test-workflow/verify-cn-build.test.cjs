const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const verifier = path.resolve(__dirname, "verify-cn-build.cjs")
const requiredFiles = [
    "cn-server.js",
    "multi/tcp/lobby.js",
    "multi/npc/controller.js",
]

function createFile(root, relativePath) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "")
}

test("fails and lists every missing CN runtime module", t => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-missing-"))
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }))

    const result = spawnSync(process.execPath, [verifier, outputDirectory], {
        encoding: "utf8",
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cn-server\.js/)
    assert.match(result.stderr, /multi\/tcp\/lobby\.js/)
    assert.match(result.stderr, /multi\/npc\/controller\.js/)
})

test("accepts a complete default out directory", t => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cn-build-complete-"))
    t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }))
    for (const relativePath of requiredFiles) {
        createFile(path.join(projectDirectory, "out"), relativePath)
    }

    const result = spawnSync(process.execPath, [verifier], {
        cwd: projectDirectory,
        encoding: "utf8",
    })

    assert.equal(result.status, 0, result.stderr)
})
