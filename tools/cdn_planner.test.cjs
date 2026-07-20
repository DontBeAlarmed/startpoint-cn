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

function diamondEdges(startVersion, prefix, layers) {
    const edges = []
    let merge = startVersion
    for (let index = 0; index < layers; index++) {
        const left = `${prefix}-left-${index}`
        const right = `${prefix}-right-${index}`
        const nextMerge = `${prefix}-merge-${index + 1}`
        edges.push(
            edge(merge, left, 1),
            edge(merge, right, 1),
            edge(left, nextMerge, 1),
            edge(right, nextMerge, 1),
        )
        merge = nextMerge
    }
    return { edges, endVersion: merge }
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

test("validates the fulfill full edge before an up-to-date shortcut", () => {
    const diff = edge("1.4.53", "1.4.54", 54)
    assertPlannerCode(() => planCdnUpdate(
        catalog([diff]),
        request({ currentVersion: "1.4.54" }),
    ), "INVALID_CATALOG")

    const wrongFull = edge(null, "1.3.0", 100)
    assertPlannerCode(() => planCdnUpdate(
        catalog([wrongFull, diff]),
        request({ currentVersion: "1.3.0", targetVersion: "1.3.0" }),
    ), "INVALID_CATALOG")
})

test("rejects multiple fulfill full edges independently of edge order", () => {
    const fullBase = edge(null, "1.4.0", 100)
    const otherFull = edge(null, "1.3.0", 90)
    const diff = edge("1.4.53", "1.4.54", 54)
    const inputOrders = [
        [fullBase, otherFull, diff],
        [diff, otherFull, fullBase],
    ]

    for (const edges of inputOrders) {
        assertPlannerCode(() => planCdnUpdate(
            catalog(edges),
            request({ currentVersion: "1.4.54" }),
        ), "INVALID_CATALOG")
    }
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

test("rejects unsupported runtime asset size kinds", () => {
    const validCatalog = catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.53", "1.4.54", 54),
    ])
    for (const assetSizeKind of ["bogus", null, undefined]) {
        assertPlannerCode(() => planCdnUpdate(
            validCatalog,
            request({ assetSizeKind }),
        ), "UNSUPPORTED_ASSET_SIZE_KIND")
    }
})

test("validates platform before asset size kind", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([]), request({
        platform: "ios",
        assetSizeKind: "bogus",
    })), "UNSUPPORTED_PLATFORM")
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

test("rejects repeated visits through a catalog cycle", () => {
    assertPlannerCode(() => planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.0", "1.4.1", 10),
        edge("1.4.1", "1.4.0", 99),
        edge("1.4.1", "1.4.54", 20),
    ]), request({ currentVersion: "1.4.0" })), "INVALID_CATALOG")
})

test("plans a 5000-edge linear chain without overflowing the call stack", () => {
    const diffs = []
    let fromVersion = "1.4.0"
    for (let index = 1; index <= 5_000; index++) {
        const toVersion = `long-${index}`
        diffs.push(edge(fromVersion, toVersion, 1))
        fromVersion = toVersion
    }

    const result = planCdnUpdate(
        catalog([edge(null, "1.4.0", 100), ...diffs]),
        request({ currentVersion: "1.4.0", targetVersion: fromVersion }),
    )

    assert.equal(result.kind, "incremental")
    assert.equal(result.diff.length, 5_000)
    assert.equal(result.diff[0], diffs[0])
    assert.equal(result.diff.at(-1), diffs.at(-1))
    assert.equal(result.downloadBytes, 5_000)
})

test("rejects a multi-layer diamond dead end as no update path", () => {
    const dead = diamondEdges("1.4.0", "unreachable", 22)
    const startedAt = process.hrtime.bigint()

    assertPlannerCode(() => planCdnUpdate(
        catalog([edge(null, "1.4.0", 100), ...dead.edges]),
        request({ currentVersion: "1.4.0", targetVersion: "missing-target" }),
    ), "NO_UPDATE_PATH")
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    assert.ok(durationMs < 5_000, `diamond traversal took ${durationMs.toFixed(0)}ms`)
})

test("returns the only live path beside a large converging dead end", () => {
    const dead = diamondEdges("dead-root", "side-dead", 18)
    const liveFirst = edge("1.4.0", "live-middle", 10)
    const liveLast = edge("live-middle", "live-target", 20)
    const result = planCdnUpdate(catalog([
        edge(null, "1.4.0", 100),
        edge("1.4.0", "dead-root", 1),
        ...dead.edges,
        liveLast,
        liveFirst,
    ]), request({ currentVersion: "1.4.0", targetVersion: "live-target" }))

    assert.deepEqual(result.diff, [liveFirst, liveLast])
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
