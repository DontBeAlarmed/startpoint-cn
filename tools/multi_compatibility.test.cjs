"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    buildBundledContentDigest,
    buildModeDigest,
    compareCompatibility,
    createCompatibilityProfileFactory,
} = require("../src/multi/compatibility")

const RELEASE_DIGEST = `sha256:${"1".repeat(64)}`

function snapshot({ releaseDigest = RELEASE_DIGEST, tables = {} } = {}) {
    return {
        cdn: { targetVersion: "1.4.54" },
        repository: {
            info: () => ({
                source: releaseDigest === null ? "bundled" : "release",
                assetVersion: "1.4.54",
                generatorVersion: 1,
                releaseDigest,
            }),
            table: tableName => tables[tableName],
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
        tableNames: [],
        source,
    })
    const result = factory({
        APP_VER: overrides.APP_VER ?? "1.8.1",
        RES_VER: overrides.RES_VER ?? "1.4.54",
    })
    assert.equal(result.ok, true)
    return result.value
}

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

test("missing, repeated, non-ASCII and oversized client version headers fail closed", () => {
    const factory = createCompatibilityProfileFactory({
        getContentSnapshot: () => snapshot(),
        getLoadedModeIdentities: () => [],
        tableNames: [],
    })
    for (const headers of [
        { RES_VER: "1.4.54" },
        { APP_VER: "1.8.1" },
        { APP_VER: ["1.8.1", "custom"], RES_VER: "1.4.54" },
        { APP_VER: "国服", RES_VER: "1.4.54" },
        { APP_VER: "x".repeat(65), RES_VER: "1.4.54" },
        { APP_VER: "1.8.1", RES_VER: "bad\nvalue" },
    ]) {
        assert.deepEqual(factory(headers), { ok: false, error: "INCOMPATIBLE_ROOM" })
    }
})

test("profile construction uses the active release digest and never invokes asset update", () => {
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
        tableNames: ["ignored-for-release.json"],
    })

    const result = factory({ app_ver: "1.8.1", res_ver: "1.4.54" })

    assert.equal(result.ok, true)
    assert.equal(result.value.contentDigest, RELEASE_DIGEST)
    assert.equal(assetUpdateCalls, 0)
})

test("bundled content digest is canonical and independent of table registration order", () => {
    const tables = {
        "z.json": { z: 1, nested: { b: 2, a: 1 } },
        "a.json": [{ value: "A" }],
    }
    const repository = snapshot({ releaseDigest: null, tables }).repository
    const forward = buildBundledContentDigest(repository, ["z.json", "a.json"])
    const reverse = buildBundledContentDigest(repository, ["a.json", "z.json"])

    assert.equal(forward, "sha256:0b029e70676ace05e333f05f4c258a03ca7d6d6ae70c905c6c0bd184507c43a6")
    assert.equal(reverse, forward)
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
