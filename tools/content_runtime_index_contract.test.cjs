"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    ContentSnapshotError,
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { getStrictRuntimeContentTableSync } = require("../src/content/runtime/table-access")
const {
    createFrozenTestContentRepository,
    installFrozenTestContentSnapshot,
} = require("./helpers/content-snapshot-fixture.cjs")

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

test("strict production access fails before Content initialization", () => {
    const previous = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = null
    try {
        assert.throws(
            () => getStrictRuntimeContentTableSync("config.json"),
            error => error instanceof ContentSnapshotError
                && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
})

test("frozen test repository provides stable identity and explicit missing-table failure", () => {
    const input = { "config.json": { limits: { max_mana: 99 }, ids: [1, 2] } }
    const repository = createFrozenTestContentRepository({
        tables: input,
        assetVersion: "same-version",
    })
    input["config.json"].limits.max_mana = 1
    input["config.json"].ids.push(3)
    const first = repository.table("config.json")
    assert.strictEqual(repository.table("config.json"), first)
    assert.deepEqual(first, { limits: { max_mana: 99 }, ids: [1, 2] })
    assertDeepFrozen(repository)
    assertDeepFrozen(repository.info())
    assertDeepFrozen(first)
    assert.throws(() => repository.table("missing.json"), /missing test content table/)

    const other = createFrozenTestContentRepository({
        tables: { "config.json": { limits: { max_mana: 99 }, ids: [1, 2] } },
        assetVersion: "same-version",
    })
    assert.notStrictEqual(other, repository)
    assert.notStrictEqual(other.table("config.json"), first)
})

test("strict access reads the installed frozen snapshot and restore is idempotent", () => {
    const previous = productionContentSnapshotProvider.snapshot
    const sentinel = Object.freeze({ marker: "sentinel" })
    productionContentSnapshotProvider.snapshot = sentinel
    try {
        const installed = installFrozenTestContentSnapshot({
            targetVersion: "release-a",
            tables: { "config.json": { nested: { max_mana: 123 } } },
        })
        assert.strictEqual(productionContentSnapshotProvider.snapshot, installed.snapshot)
        assertDeepFrozen(installed.snapshot)
        const strict = getStrictRuntimeContentTableSync("config.json")
        assert.deepEqual(strict, { nested: { max_mana: 123 } })
        assert.strictEqual(getStrictRuntimeContentTableSync("config.json"), strict)
        assert.throws(
            () => getStrictRuntimeContentTableSync("missing.json"),
            /missing test content table/,
        )
        installed.restore()
        assert.strictEqual(productionContentSnapshotProvider.snapshot, sentinel)
        installed.restore()
        assert.strictEqual(productionContentSnapshotProvider.snapshot, sentinel)
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
})

test("strict access propagates repository errors instead of swallowing them", () => {
    const previous = productionContentSnapshotProvider.snapshot
    const repositoryError = new ContentSnapshotError(
        "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        "repository failure",
    )
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "damaged" },
        archiveSources: { schemaVersion: 1, archives: [] },
        repository: {
            info: () => ({}),
            table() { throw repositoryError },
        },
    }
    try {
        assert.throws(
            () => getStrictRuntimeContentTableSync("config.json"),
            error => error === repositoryError,
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
})
