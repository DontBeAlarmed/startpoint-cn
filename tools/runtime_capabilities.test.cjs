"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { canonicalJsonBuffer, sha256Object } = require("../src/content/sync/canonical-json")
const {
    createRuntimeCapabilitiesSnapshot,
    registerRuntimeCapabilitiesRoute,
    RUNTIME_API_VERSION,
} = require("../src/runtime/capabilities")

const RELEASE_DIGEST = `sha256:${"a".repeat(64)}`
const CONTENT_DIGEST = `sha256:${"b".repeat(64)}`
const MODE_CAPABILITIES = [
    "mode.hook.quest-start@1",
    "mode.hook.rush-finish@1",
    "mode.hook.rush-parties-serialized@1",
    "mode.host.base-table@1",
    "mode.host.transaction-server@1",
]

function compareCodePoint(left, right) {
    const l = Array.from(left, value => value.codePointAt(0))
    const r = Array.from(right, value => value.codePointAt(0))
    for (let index = 0; index < Math.min(l.length, r.length); index++) {
        if (l[index] !== r[index]) return l[index] - r[index]
    }
    return l.length - r.length
}

function modeDigest(identities) {
    const canonical = [...identities]
        .sort((left, right) => compareCodePoint(left.fileName, right.fileName)
            || compareCodePoint(left.name, right.name))
        .map(identity => ({
            fileName: identity.fileName,
            name: identity.name,
            capability: identity.capability,
            sha256: identity.sha256,
        }))
    return sha256Object(canonicalJsonBuffer(canonical))
}

function contentSnapshot() {
    return {
        cdn: { targetVersion: "1.4.58" },
        archiveSources: {
            archives: [
                { source: { kind: "patch", targetVersion: "1.4.58" } },
                { source: { kind: "baseline" } },
                { source: { kind: "patch", targetVersion: "1.4.55" } },
            ],
        },
        repository: {
            info: () => ({
                source: "release",
                assetVersion: "1.4.58",
                generatorVersion: 3,
                releaseDigest: RELEASE_DIGEST,
                contentDigest: CONTENT_DIGEST,
            }),
        },
    }
}

function validInput(overrides = {}) {
    return {
        bundle: { version: "1.0.1", bundleId: null },
        content: contentSnapshot(),
        loadedModes: [{
            fileName: "20-fixture.mjs",
            name: "fixture",
            capability: "fixture@1",
            sha256: "c".repeat(64),
        }],
        node: "20.20.2",
        nodeAbi: "115",
        platform: "win32",
        arch: "x64",
        ...overrides,
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

test("builds the exact frozen v1 capabilities body from local public facts", () => {
    const input = validInput()
    const body = createRuntimeCapabilitiesSnapshot(input)

    assert.deepEqual(body, {
        contractVersion: 1,
        serverCapabilities: ["content.sync@1", ...MODE_CAPABILITIES],
        serverBundle: { version: "1.0.1", bundleId: null },
        runtime: {
            api: 1,
            node: "20.20.2",
            nodeAbi: "115",
            platform: "win32",
            arch: "x64",
        },
        content: {
            source: "release",
            assetVersion: "1.4.58",
            generatorVersion: 3,
            releaseDigest: RELEASE_DIGEST,
            contentDigest: CONTENT_DIGEST,
            cdnTargetVersion: "1.4.58",
            patchVersions: ["1.4.55", "1.4.58"],
        },
        modes: {
            api: 1,
            serverCapabilities: MODE_CAPABILITIES,
            loaded: [{
                name: "fixture",
                capabilities: ["fixture@1"],
                sha256: "c".repeat(64),
            }],
            modeDigest: modeDigest(input.loadedModes),
        },
        features: {
            patchOverlaySchema: 1,
            modeChangesRequireRestart: true,
            activeContentManagement: false,
        },
    })
    assertDeepFrozen(body)
    assert.equal(RUNTIME_API_VERSION, 1)
    assert.equal(body.serverCapabilities.includes("mode.release-contract@1"), false)
    assert.equal(body.modes.loaded.some(identity => "fileName" in identity), false)
    assert.doesNotMatch(
        JSON.stringify(body),
        /DATA_DIR|CDN_DIR|pid|memory|token|player|\\Users\\|\/Users\//i,
    )
})

test("sorts copied mode and patch facts without trusting caller mutation", () => {
    const bmpPrivate = "\uE000"
    const astral = "\u{10000}"
    const loadedModes = [
        {
            fileName: `${astral}.mjs`,
            name: "astral",
            capability: "astral@1",
            sha256: "d".repeat(64),
        },
        {
            fileName: `${bmpPrivate}.mjs`,
            name: "bmp-private",
            capability: "bmp-private@1",
            sha256: "e".repeat(64),
        },
    ]
    const content = contentSnapshot()
    content.archiveSources.archives = [
        { source: { kind: "patch", targetVersion: "1.4.10" } },
        { source: { kind: "patch", targetVersion: "1.4.9" } },
    ]
    const body = createRuntimeCapabilitiesSnapshot(validInput({ content, loadedModes }))

    loadedModes.length = 0
    content.archiveSources.archives.push({
        source: { kind: "patch", targetVersion: "9.9.9" },
    })

    assert.deepEqual(body.modes.loaded.map(identity => identity.name), ["bmp-private", "astral"])
    assert.deepEqual(body.modes.loaded[1].capabilities, ["astral@1"])
    assert.deepEqual(body.content.patchVersions, ["1.4.9", "1.4.10"])
})

test("rejects invalid public runtime identities", () => {
    const cases = [
        validInput({ nodeAbi: "11x" }),
        validInput({ bundle: { version: "1.0.1", bundleId: "sha256:invalid" } }),
        validInput({ loadedModes: [{
            fileName: "fixture.mjs",
            name: "fixture",
            capability: "fixture@1",
            sha256: "invalid",
        }] }),
        validInput({ loadedModes: [{
            fileName: "fixture.mjs",
            name: "fixture",
            capability: "",
            sha256: "d".repeat(64),
        }] }),
    ]
    for (const input of cases) {
        assert.throws(() => createRuntimeCapabilitiesSnapshot(input), TypeError)
    }
})

test("preserves Mode API v1 nonempty third-party capability strings", () => {
    const input = validInput({
        loadedModes: [{
            fileName: "legacy-third-party.mjs",
            name: "legacy-third-party",
            capability: "Legacy Third Party Capability",
            sha256: "f".repeat(64),
        }],
    })

    const body = createRuntimeCapabilitiesSnapshot(input)

    assert.deepEqual(body.modes.loaded, [{
        name: "legacy-third-party",
        capabilities: ["Legacy Third Party Capability"],
        sha256: "f".repeat(64),
    }])
    assert.equal(body.modes.modeDigest, modeDigest(input.loadedModes))
    assert.equal(body.serverCapabilities.includes("Legacy Third Party Capability"), false)
})

test("local capabilities route returns exact JSON", async t => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const body = createRuntimeCapabilitiesSnapshot(validInput())

    registerRuntimeCapabilitiesRoute(app, () => body)
    const response = await app.inject({ method: "GET", url: "/api/server/capabilities" })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-type"].startsWith("application/json"), true)
    assert.deepEqual(response.json(), body)
})
