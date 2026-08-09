"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    buildModeDigest,
    compareCompatibility,
    createCompatibilityProfileFactory,
} = require("../src/multi/compatibility")
const { ContentSnapshotError } = require("../src/content/runtime/content-snapshot")

const RELEASE_DIGEST = `sha256:${"1".repeat(64)}`
const BUNDLED_DIGEST = `sha256:${"4".repeat(64)}`
const MULTI_BATTLE_DIGEST = `sha256:${"7".repeat(64)}`

function snapshot({
    releaseDigest = RELEASE_DIGEST,
    contentDigest = releaseDigest ?? BUNDLED_DIGEST,
    multiBattleContentDigest = MULTI_BATTLE_DIGEST,
    table = () => undefined,
} = {}) {
    return {
        cdn: { targetVersion: "1.4.54" },
        repository: {
            info: () => ({
                source: releaseDigest === null ? "bundled" : "release",
                assetVersion: "1.4.54",
                generatorVersion: 1,
                releaseDigest,
                contentDigest,
                multiBattleContentDigest,
            }),
            table,
        },
    }
}

function profile(overrides = {}) {
    const source = {
        cdnTargetVersion: "1.4.54",
        contentDigest: RELEASE_DIGEST,
        modeDigest: `sha256:${"2".repeat(64)}`,
        ...overrides.source,
    }
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => snapshot(),
        getLoadedModeIdentities: () => [],
        source,
    })
    const result = factory({
        APP_VER: overrides.APP_VER ?? "1.8.1",
        RES_VER: overrides.RES_VER ?? "1.4.54",
    })
    assert.equal(result.ok, true)
    return result.value
}

test("profile source is resolved on first valid request and caches only the successful source", () => {
    let snapshotCalls = 0
    let modeCalls = 0
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => {
            snapshotCalls++
            return snapshot()
        },
        getLoadedModeIdentities: () => {
            modeCalls++
            return []
        },
    })

    assert.equal(snapshotCalls, 0)
    assert.equal(modeCalls, 0)
    assert.deepEqual(factory({ RES_VER: "1.4.54" }), {
        ok: false,
        error: "INCOMPATIBLE_ROOM",
    })
    assert.equal(snapshotCalls, 0)
    assert.equal(modeCalls, 0)

    const first = factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" })
    const second = factory({ APP_VER: "custom", RES_VER: "custom-resource" })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.value.contentDigest, MULTI_BATTLE_DIGEST)
    assert.equal(second.value.contentDigest, MULTI_BATTLE_DIGEST)
    assert.equal(snapshotCalls, 1)
    assert.equal(modeCalls, 1)
})

test("profile source failure is controlled, not cached, and recovers after initialization", () => {
    let initialized = false
    let snapshotCalls = 0
    let modeCalls = 0
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => {
            snapshotCalls++
            if (!initialized) {
                throw new ContentSnapshotError(
                    "CONTENT_SNAPSHOT_NOT_INITIALIZED",
                    "controlled test",
                )
            }
            return snapshot()
        },
        getLoadedModeIdentities: () => {
            modeCalls++
            return []
        },
    })

    assert.equal(snapshotCalls, 0)
    assert.deepEqual(factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" }), {
        ok: false,
        error: "INCOMPATIBLE_ROOM",
    })
    assert.equal(snapshotCalls, 1)
    assert.equal(modeCalls, 0)

    initialized = true
    const recovered = factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" })
    const cached = factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" })

    assert.equal(recovered.ok, true)
    assert.equal(cached.ok, true)
    assert.equal(snapshotCalls, 2)
    assert.equal(modeCalls, 1)
})

test("only the exact uninitialized ContentSnapshotError is mapped to incompatibility", () => {
    const wrongCode = new ContentSnapshotError(
        "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        "wrong code test",
    )
    wrongCode.code = "CONTENT_SNAPSHOT_CORRUPT"
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => { throw wrongCode },
        getLoadedModeIdentities: () => [],
    })

    assert.throws(
        () => factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" }),
        error => error === wrongCode,
    )
})

test("unexpected source failures are rethrown unchanged and remain recoverable", async t => {
    const scenarios = [
        {
            name: "snapshot dependency",
            createFailure: () => {
                const error = new Error("generic snapshot failure")
                return {
                    error,
                    dependencies: {
                        getContentSnapshot: () => { throw error },
                        getLoadedModeIdentities: () => [],
                    },
                }
            },
        },
        {
            name: "snapshot structure",
            createFailure: () => ({
                dependencies: {
                    getContentSnapshot: () => ({}),
                    getLoadedModeIdentities: () => [],
                },
                errorType: TypeError,
            }),
        },
        {
            name: "repository info",
            createFailure: () => {
                const error = new Error("repository info failure")
                return {
                    error,
                    dependencies: {
                        getContentSnapshot: () => ({
                            ...snapshot(),
                            repository: {
                                info: () => { throw error },
                                table: () => undefined,
                            },
                        }),
                        getLoadedModeIdentities: () => [],
                    },
                }
            },
        },
        {
            name: "mode registry",
            createFailure: () => {
                const error = new Error("mode registry failure")
                return {
                    error,
                    dependencies: {
                        getContentSnapshot: () => snapshot(),
                        getLoadedModeIdentities: () => { throw error },
                    },
                }
            },
        },
        {
            name: "mode digest",
            createFailure: () => ({
                dependencies: {
                    getContentSnapshot: () => snapshot(),
                    getLoadedModeIdentities: () => [{
                        fileName: undefined,
                        name: "invalid",
                        capability: "invalid@1",
                        sha256: "a".repeat(64),
                    }],
                },
                errorType: TypeError,
            }),
        },
    ]

    for (const scenario of scenarios) {
        await t.test(scenario.name, () => {
            let failing = true
            const failure = scenario.createFailure()
            const factory = createCompatibilityProfileFactory({
                getContentSnapshot: () => failing
                    ? failure.dependencies.getContentSnapshot()
                    : snapshot(),
                getLoadedModeIdentities: () => failing
                    ? failure.dependencies.getLoadedModeIdentities()
                    : [],
            })

            if (failure.error) {
                assert.throws(
                    () => factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" }),
                    error => error === failure.error,
                )
            } else {
                assert.throws(
                    () => factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" }),
                    failure.errorType,
                )
            }
            failing = false
            assert.equal(factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" }).ok, true)
        })
    }
})

test("fixed profile source never reads snapshot or mode dependencies", () => {
    let dependencyCalls = 0
    const source = {
        cdnTargetVersion: "fixed-cdn",
        contentDigest: `sha256:${"5".repeat(64)}`,
        modeDigest: `sha256:${"6".repeat(64)}`,
    }
    const factory = createCompatibilityProfileFactory({
        source,
        getContentSnapshot: () => {
            dependencyCalls++
            throw new Error("fixed source must not read snapshot")
        },
        getLoadedModeIdentities: () => {
            dependencyCalls++
            throw new Error("fixed source must not read modes")
        },
    })

    const result = factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" })

    assert.equal(result.ok, true)
    assert.deepEqual(result.value, {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "1.4.54",
        ...source,
    })
    assert.equal(dependencyCalls, 0)
})

test("profile contains only the six room compatibility fields", () => {
    const host = profile()
    assert.deepEqual(host, {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "1.4.54",
        cdnTargetVersion: "1.4.54",
        contentDigest: RELEASE_DIGEST,
        modeDigest: `sha256:${"2".repeat(64)}`,
    })
    for (const diagnostic of [
        "serverTime", "timeOffset", "serverVersion", "bundleId", "database", "secret",
    ]) {
        assert.equal(diagnostic in host, false)
    }
})

test("comparison is exact and reports differences in schema order", () => {
    const host = profile()
    assert.deepEqual(compareCompatibility(host, host), {
        compatible: true,
        differences: [],
    })

    const guest = profile({
        APP_VER: "custom",
        RES_VER: "custom-resource",
        source: {
            contentDigest: `sha256:${"3".repeat(64)}`,
        },
    })
    assert.deepEqual(compareCompatibility(host, guest), {
        compatible: false,
        differences: [
            { field: "APP_VER", host: "1.8.1", guest: "custom" },
            { field: "RES_VER", host: "1.4.54", guest: "custom-resource" },
            {
                field: "contentDigest",
                host: RELEASE_DIGEST,
                guest: `sha256:${"3".repeat(64)}`,
            },
        ],
    })
})

test("each admission field independently blocks room compatibility", () => {
    const host = profile()
    for (const [field, guest] of [
        ["multiProtocolVersion", { ...host, multiProtocolVersion: 2 }],
        ["APP_VER", { ...host, APP_VER: "custom" }],
        ["contentDigest", { ...host, contentDigest: `sha256:${"3".repeat(64)}` }],
        ["modeDigest", { ...host, modeDigest: `sha256:${"4".repeat(64)}` }],
    ]) {
        const comparison = compareCompatibility(host, guest)
        assert.equal(comparison.compatible, false, field)
        assert.deepEqual(comparison.differences.map(difference => difference.field), [field])
    }
})

test("resource and CDN version differences remain diagnostic without blocking rooms", () => {
    const host = profile()
    const guest = profile({
        RES_VER: "1.4.55",
        source: { cdnTargetVersion: "1.4.55" },
    })

    assert.deepEqual(compareCompatibility(host, guest), {
        compatible: true,
        differences: [
            { field: "RES_VER", host: "1.4.54", guest: "1.4.55" },
            { field: "cdnTargetVersion", host: "1.4.54", guest: "1.4.55" },
        ],
    })
})

test("missing, repeated, non-ASCII and oversized application versions fail closed", () => {
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => snapshot(),
        getLoadedModeIdentities: () => [],
    })
    for (const headers of [
        { RES_VER: "1.4.54" },
        { APP_VER: ["1.8.1", "custom"], RES_VER: "1.4.54" },
        { APP_VER: "国服", RES_VER: "1.4.54" },
        { APP_VER: "x".repeat(65), RES_VER: "1.4.54" },
    ]) {
        assert.deepEqual(factory(headers), { ok: false, error: "INCOMPATIBLE_ROOM" })
    }
})

test("missing or invalid resource versions use a diagnostic placeholder", () => {
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => snapshot(),
        getLoadedModeIdentities: () => [],
    })
    for (const headers of [
        { APP_VER: "1.8.1" },
        { APP_VER: "1.8.1", RES_VER: ["1.4.54", "1.4.55"] },
        { APP_VER: "1.8.1", RES_VER: "国服" },
        { APP_VER: "1.8.1", RES_VER: "x".repeat(65) },
        { APP_VER: "1.8.1", RES_VER: "bad\nvalue" },
    ]) {
        const result = factory(headers)
        assert.equal(result.ok, true)
        assert.equal(result.value.RES_VER, "unknown")
    }
})

test("profile construction uses the multiplayer battle digest and never invokes asset update", () => {
    let assetUpdateCalls = 0
    const activeSnapshot = snapshot()
    Object.defineProperty(activeSnapshot, "assetUpdate", {
        enumerable: false,
        get() {
            assetUpdateCalls++
            throw new Error("asset update must stay outside compatibility construction")
        },
    })
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => activeSnapshot,
        getLoadedModeIdentities: () => [],
    })

    const result = factory({ app_ver: "1.8.1", res_ver: "1.4.54" })

    assert.equal(result.ok, true)
    assert.equal(result.value.contentDigest, MULTI_BATTLE_DIGEST)
    assert.equal(assetUpdateCalls, 0)
})

test("profile reads the loaded multiplayer battle digest without table access", () => {
    let tableCalls = 0
    const activeSnapshot = snapshot({
        releaseDigest: null,
        contentDigest: BUNDLED_DIGEST,
        multiBattleContentDigest: MULTI_BATTLE_DIGEST,
        table: () => {
            tableCalls++
            throw new Error("compatibility profile must not access content tables")
        },
    })
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => activeSnapshot,
        getLoadedModeIdentities: () => [],
    })

    const result = factory({ APP_VER: "1.8.1", RES_VER: "1.4.54" })

    assert.equal(result.ok, true)
    assert.equal(result.value.contentDigest, MULTI_BATTLE_DIGEST)
    assert.equal(tableCalls, 0)
})

test("mode digest includes only validated loaded identities in stable order", () => {
    const first = {
        fileName: "z-mode.mjs",
        name: "zeta",
        capability: "zeta@1",
        sha256: "a".repeat(64),
    }
    const second = {
        fileName: "a-mode.mjs",
        name: "alpha",
        capability: "alpha@1",
        sha256: "b".repeat(64),
    }
    const expected = "sha256:0c4ab71221fedee9fb5892bf3fcc82251d280daafad3b6e438f7a9ab584c11fa"

    assert.equal(buildModeDigest([first, second]), expected)
    assert.equal(buildModeDigest([second, first]), expected)
    assert.notEqual(buildModeDigest([first]), expected)
    assert.equal(
        buildModeDigest([]),
        "sha256:37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
    )
})
