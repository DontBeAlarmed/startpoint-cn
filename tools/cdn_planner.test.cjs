"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { CdnPlannerError, planCdnUpdate } = require("../src/content/cdn/planner")

function archive(relativePath, compressedBytes) {
    return {
        relativePath,
        compressedBytes,
        sha256: "a".repeat(64),
        layer: "common",
        order: 1,
    }
}

function edge(fromVersion, toVersion, compressedBytes, overrides = {}) {
    const kind = fromVersion === null ? "full" : "diff"
    return {
        fromVersion,
        toVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        archives: [archive(
            `archive-common-${kind}/${fromVersion ?? "full"}-${toVersion}.zip`,
            compressedBytes,
        )],
        ...overrides,
    }
}

function catalog(edges) {
    return {
        schemaVersion: 1,
        fullBaseVersion: "1.4.0",
        targetVersion: "1.4.54",
        installedBytes: 1_000,
        entityListsRelativePath: "EntityLists/android_medium.csv",
        edges,
    }
}

function request(overrides = {}) {
    return {
        currentVersion: "1.4.53",
        targetVersion: "1.4.54",
        platform: "android",
        assetSizeKind: "fulfill",
        isInitial: false,
        ...overrides,
    }
}

function assertPlannerCode(callback, code) {
    assert.throws(callback, error => (
        error instanceof CdnPlannerError
        && error.code === code
        && error.name === "CdnPlannerError"
    ))
}

test("returns Option.None fields and zero bytes when the client is current", () => {
    const result = planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ]), request({ currentVersion: "1.4.54" }))

    assert.deepEqual(result, {
        kind: "up-to-date",
        full: null,
        diff: null,
        downloadBytes: 0,
        delayedAssetsBytes: 0,
    })
})

test("returns only the requested incremental edge and sums its archives", () => {
    const requestedEdge = edge("1.4.53", "1.4.54", 40, {
        archives: [archive("archive-common-diff/requested-a.zip", 40), archive("archive-android-diff/requested-b.zip", 14)],
    })
    const result = planCdnUpdate(catalog([
        edge("1.4.54", "1.4.55", 55),
        edge("1.4.52", "1.4.53", 53),
        edge("9.0.0", "9.0.1", 900),
        requestedEdge,
        edge(null, "1.4.0", 100),
    ]), request())

    assert.deepEqual(result, {
        kind: "incremental",
        full: null,
        diff: [requestedEdge],
        downloadBytes: 54,
        delayedAssetsBytes: 0,
    })
})

test("returns the full base and only its continuous path to the initial target", () => {
    const full = edge(null, "1.4.0", 100)
    const first = edge("1.4.0", "1.4.20", 20)
    const second = edge("1.4.20", "1.4.54", 54)
    const result = planCdnUpdate(catalog([
        edge("1.4.54", "1.4.55", 55),
        edge("1.4.0", "8.0.0", 800),
        second,
        full,
        first,
    ]), request({ currentVersion: null, isInitial: true }))

    assert.deepEqual(result, {
        kind: "initial",
        full,
        diff: [first, second],
        downloadBytes: 174,
        delayedAssetsBytes: 0,
    })
})

test("returns a null diff when the initial target is the full base", () => {
    const full = edge(null, "1.4.0", 100)
    const result = planCdnUpdate(catalog([
        edge("1.4.0", "1.4.54", 54),
        full,
    ]), request({ currentVersion: null, targetVersion: "1.4.0", isInitial: true }))

    assert.deepEqual(result, {
        kind: "initial",
        full,
        diff: null,
        downloadBytes: 100,
        delayedAssetsBytes: 0,
    })
})

test("keeps initial installation authoritative when current equals target", () => {
    const full = edge(null, "1.4.0", 100)
    const result = planCdnUpdate(catalog([full]), request({
        currentVersion: "1.4.0",
        targetVersion: "1.4.0",
        isInitial: true,
    }))

    assert.equal(result.kind, "initial")
    assert.equal(result.full, full)
    assert.equal(result.diff, null)
})

test("rejects an unknown non-initial current version", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ]), request({ currentVersion: "1.3.99" })), "UNKNOWN_CURRENT_VERSION")

    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ]), request({ currentVersion: 1453 })), "UNKNOWN_CURRENT_VERSION")
})

test("reports no path when a known current version cannot reach the target", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.52", "1.4.53", 53),
    ]), request({ targetVersion: "1.4.54" })), "NO_UPDATE_PATH")

    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ]), request({ targetVersion: "not-a-version" })), "NO_UPDATE_PATH")
})

test("rejects multiple distinct paths to the target", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.0", "1.4.1", 11),
        edge("1.4.1", "1.4.54", 12),
        edge("1.4.0", "1.4.2", 21),
        edge("1.4.2", "1.4.54", 22),
    ]), request({ currentVersion: "1.4.0" })), "AMBIGUOUS_UPDATE_PATH")
})

test("rejects unsupported runtime platforms", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ]), request({ platform: "ios" })), "UNSUPPORTED_PLATFORM")
})

test("uses fulfill archives for both asset size kinds", () => {
    const fulfill = edge("1.4.53", "1.4.54", 54)
    const shortened = edge("1.4.53", "1.4.54", 5, {
        assetSizeKind: "shortened",
        archives: [archive("archive-common-diff/shortened-only.zip", 5)],
    })
    const sharedCatalog = catalog([edge(null, "1.4.0", 100), shortened, fulfill])

    const fulfillPlan = planCdnUpdate(sharedCatalog, request({ assetSizeKind: "fulfill" }))
    const shortenedPlan = planCdnUpdate(sharedCatalog, request({ assetSizeKind: "shortened" }))

    assert.deepEqual(shortenedPlan, fulfillPlan)
    assert.equal(shortenedPlan.diff[0], fulfill)
    assert.deepEqual(
        shortenedPlan.diff[0].archives.map(item => [item.relativePath, item.compressedBytes]),
        fulfillPlan.diff[0].archives.map(item => [item.relativePath, item.compressedBytes]),
    )
    assert.equal(shortenedPlan.delayedAssetsBytes, 0)
})

test("is deterministic when catalog edges are shuffled", () => {
    const edges = [
        edge(null, "1.4.0", 100),
        edge("1.4.0", "1.4.20", 20),
        edge("1.4.20", "1.4.54", 54),
        edge("1.4.0", "7.0.0", 700),
        edge("1.4.54", "1.4.55", 55),
    ]
    const initialRequest = request({ currentVersion: null, isInitial: true })

    assert.deepEqual(
        planCdnUpdate(catalog(edges), initialRequest),
        planCdnUpdate(catalog([...edges].reverse()), initialRequest),
    )
})

test("does not modify the input catalog", () => {
    const input = catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ])
    const snapshot = structuredClone(input)

    planCdnUpdate(input, request())

    assert.deepEqual(input, snapshot)
})

test("avoids repeated visits while finding the only simple path", () => {
    const first = edge("1.4.0", "1.4.1", 10)
    const last = edge("1.4.1", "1.4.54", 20)
    const result = planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.1", "1.4.0", 99),
        last,
        first,
    ]), request({ currentVersion: "1.4.0" }))

    assert.deepEqual(result.diff, [first, last])
    assert.equal(result.downloadBytes, 30)
})

test("rejects unsafe archive byte totals", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", Number.NaN),
    ]), request()), "INVALID_DOWNLOAD_BYTES")

    const unsafeEdge = edge("1.4.53", "1.4.54", 1, {
        archives: [
            archive("archive-common-diff/max.zip", Number.MAX_SAFE_INTEGER),
            archive("archive-android-diff/overflow.zip", 1),
        ],
    })
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        unsafeEdge,
    ]), request()), "INVALID_DOWNLOAD_BYTES")
})
