"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const verifierPath = path.join(projectRoot, "tools/runtime-pack/verify.cjs")
const { canonicalJsonBuffer } = require("./server-bundle/canonical-json.cjs")

function write(root, relativePath, contents) {
    const destination = path.join(root, ...relativePath.split("/"))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, contents)
}

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-pack-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const files = [
        ["node/bin/node", Buffer.from("android node runtime\n")],
        ["node/lib/libnode.so", Buffer.from("node library\n")],
        ["node_modules/better-sqlite3/build/Release/better_sqlite3.node", Buffer.from("native module\n")],
    ]
    for (const [relativePath, bytes] of files) write(root, relativePath, bytes)

    const manifest = {
        schemaVersion: 1,
        runtimeId: "sha256:" + "0".repeat(64),
        runtimeApi: 1,
        node: {
            version: "20.12.2",
            abi: "115",
            platform: "android",
            arch: "arm64",
        },
        dependencyLock: "sha256:" + "1".repeat(64),
        entry: "node/bin/node",
        executables: ["node/bin/node"],
        files: files.map(([relativePath, bytes]) => ({
            path: relativePath,
            bytes: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        })),
    }
    const { runtimeId: _ignored, ...digestInput } = manifest
    manifest.runtimeId = "sha256:" + crypto.createHash("sha256")
        .update(canonicalJsonBuffer(digestInput)).digest("hex")
    write(root, "runtime-pack-manifest.json", canonicalJsonBuffer(manifest))
    return { root, manifest }
}

function loadVerifier() {
    assert.equal(fs.existsSync(verifierPath), true, "runtime pack verifier must exist")
    return require(verifierPath)
}

test("verifies a canonical Runtime Pack and its file hashes", t => {
    const { root, manifest } = createFixture(t)
    const { verifyRuntimePack } = loadVerifier()

    assert.deepEqual(verifyRuntimePack({
        runtimeRoot: root,
        expectedPlatform: "android",
        expectedArch: "arm64",
        expectedNodeAbi: "115",
        expectedDependencyLock: manifest.dependencyLock,
    }), manifest)
})

test("rejects an unlisted file, a changed file, and an unsafe manifest path", t => {
    const { root } = createFixture(t)
    const { verifyRuntimePack } = loadVerifier()

    write(root, "node/lib/extra.bin", "not listed")
    assert.throws(() => verifyRuntimePack({ runtimeRoot: root }), /extra file/i)

    fs.unlinkSync(path.join(root, "node/lib/extra.bin"))
    fs.appendFileSync(path.join(root, "node/lib/libnode.so"), "changed")
    assert.throws(() => verifyRuntimePack({ runtimeRoot: root }), /hash|size/i)

    const manifestPath = path.join(root, "runtime-pack-manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    manifest.files[0].path = "../outside"
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => verifyRuntimePack({ runtimeRoot: root }), /canonical|unsafe/i)
})

test("rejects Runtime Pack compatibility mismatches", t => {
    const { root, manifest } = createFixture(t)
    const { verifyRuntimePack } = loadVerifier()

    assert.throws(
        () => verifyRuntimePack({ runtimeRoot: root, expectedPlatform: "linux" }),
        /platform/i,
    )
    assert.throws(
        () => verifyRuntimePack({ runtimeRoot: root, expectedNodeAbi: "999" }),
        /ABI/i,
    )
    assert.throws(
        () => verifyRuntimePack({
            runtimeRoot: root,
            expectedDependencyLock: "sha256:" + "f".repeat(64),
        }),
        /dependencyLock/i,
    )
    assert.throws(
        () => verifyRuntimePack({ runtimeRoot: root, expectedRuntimeApi: 2 }),
        /runtimeApi/i,
    )
    assert.match(manifest.runtimeId, /^sha256:[0-9a-f]{64}$/)
})

test("parses explicit Runtime Pack compatibility arguments", () => {
    const { parseArguments } = loadVerifier()
    assert.deepEqual(parseArguments([
        "/runtime",
        "--platform", "android",
        "--arch", "arm64",
        "--node-abi", "115",
        "--runtime-api", "1",
        "--dependency-lock", "sha256:" + "1".repeat(64),
    ]), {
        runtimeRoot: "/runtime",
        expectedPlatform: "android",
        expectedArch: "arm64",
        expectedNodeAbi: "115",
        expectedRuntimeApi: 1,
        expectedDependencyLock: "sha256:" + "1".repeat(64),
    })
})
