"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    CONTENT_GENERATOR_VERSION,
    CONTENT_RUNTIME_SCHEMA_VERSION,
    CONTENT_SCHEMA_VERSION,
    createReleaseManifest,
    digestReleaseManifest,
    parseCurrentPointer,
    parseReleaseManifest,
} = require("../src/content/sync/schema")
const {
    canonicalJsonBuffer,
    sha256Object,
} = require("../src/content/sync/canonical-json")

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`
const DIGEST_C = `sha256:${"c".repeat(64)}`

function validReleaseInput() {
    return {
        schemaVersion: 1,
        assetVersion: "1.4.55",
        runtimeSchemaVersion: 1,
        generatorVersion: 1,
        tables: {
            "cdndata/character_text.json": {
                object: DIGEST_C,
                scope: "cdn",
                converterId: "character",
                converterVersion: 1,
                sources: ["master/character/character_text.orderedmap"],
            },
            "character.json": {
                object: DIGEST_A,
                scope: "cdn",
                converterId: "character",
                converterVersion: 1,
                sources: ["orderedmap/character/character.json"],
            },
            "server_settings.json": {
                object: DIGEST_B,
                scope: "server",
                converterId: "server-settings",
                converterVersion: 2,
                sources: [],
            },
        },
        catalog: { object: DIGEST_B },
        summary: { object: DIGEST_C },
    }
}

function validManifest() {
    return createReleaseManifest(validReleaseInput())
}

test("exports the initial content schema versions", () => {
    assert.equal(CONTENT_SCHEMA_VERSION, 1)
    assert.equal(CONTENT_RUNTIME_SCHEMA_VERSION, 1)
    assert.equal(CONTENT_GENERATOR_VERSION, 1)
})

test("canonical JSON recursively sorts object keys and preserves array order", () => {
    const left = canonicalJsonBuffer({
        z: 1,
        a: { y: 2, x: 3 },
        values: [{ second: true, first: false }, "tail"],
    })
    const right = canonicalJsonBuffer({
        values: [{ first: false, second: true }, "tail"],
        a: { x: 3, y: 2 },
        z: 1,
    })
    const reorderedArray = canonicalJsonBuffer({
        a: { x: 3, y: 2 },
        values: ["tail", { first: false, second: true }],
        z: 1,
    })

    assert.deepEqual(left, right)
    assert.notDeepEqual(left, reorderedArray)
    assert.equal(
        left.toString("utf8"),
        '{"a":{"x":3,"y":2},"values":[{"first":false,"second":true},"tail"],"z":1}\n',
    )
    assert.equal(left.at(-1), 0x0a)
    assert.notEqual(left.at(-2), 0x0a)
})

test("canonical JSON accepts only genuine JSON values", () => {
    class Example {
        constructor() {
            this.value = 1
        }
    }

    const cyclic = {}
    cyclic.self = cyclic
    const sparse = []
    sparse[1] = "value"
    const symbolProperty = { value: 1 }
    symbolProperty[Symbol("hidden")] = 2

    const invalidValues = [
        undefined,
        { nested: undefined },
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
        1n,
        Buffer.from("value"),
        new Date("2026-07-22T00:00:00Z"),
        new Example(),
        cyclic,
        sparse,
        () => null,
        Symbol("value"),
        symbolProperty,
    ]

    for (const value of invalidValues) {
        assert.throws(() => canonicalJsonBuffer(value), undefined, String(value))
    }
})

test("sha256Object returns a prefixed lowercase SHA-256 digest", () => {
    const bytes = Buffer.from("content\n", "utf8")
    const expected = crypto.createHash("sha256").update(bytes).digest("hex")
    const digest = sha256Object(bytes)

    assert.equal(digest, `sha256:${expected}`)
    assert.match(digest, /^sha256:[0-9a-f]{64}$/)
})

test("release manifests are deterministic and exclude releaseDigest from its digest", () => {
    const input = validReleaseInput()
    const reorderedInput = {
        summary: input.summary,
        catalog: input.catalog,
        tables: {
            "server_settings.json": input.tables["server_settings.json"],
            "character.json": input.tables["character.json"],
            "cdndata/character_text.json": input.tables["cdndata/character_text.json"],
        },
        generatorVersion: input.generatorVersion,
        runtimeSchemaVersion: input.runtimeSchemaVersion,
        assetVersion: input.assetVersion,
        schemaVersion: input.schemaVersion,
    }
    const manifest = createReleaseManifest(input)
    const reordered = createReleaseManifest(reorderedInput)

    assert.equal(manifest.releaseDigest, digestReleaseManifest(manifest))
    assert.equal(manifest.releaseDigest, reordered.releaseDigest)
    assert.equal(
        digestReleaseManifest({ ...manifest, releaseDigest: DIGEST_A }),
        manifest.releaseDigest,
    )
    assert.deepEqual(parseReleaseManifest(JSON.parse(JSON.stringify(manifest))), manifest)
})

test("strictly parses valid release manifests and current pointers", () => {
    const manifest = validManifest()
    const current = {
        schemaVersion: 1,
        assetVersion: manifest.assetVersion,
        release: `releases/${manifest.assetVersion}-${manifest.releaseDigest.slice(7)}/manifest.json`,
    }

    const parsedManifest = parseReleaseManifest(manifest)
    const parsedCurrent = parseCurrentPointer(JSON.parse(JSON.stringify(current)))
    assert.deepEqual(parsedManifest, manifest)
    assert.deepEqual(parsedCurrent, current)
    assert.ok(Object.isFrozen(parsedManifest))
    assert.ok(Object.isFrozen(parsedManifest.tables))
    assert.ok(Object.isFrozen(parsedManifest.tables["character.json"].sources))
    assert.ok(Object.isFrozen(parsedCurrent))
    assert.throws(() => parsedManifest.tables["character.json"].sources.push("mutated"))
})

test("accepts historical or future positive generator versions", () => {
    const manifest = createReleaseManifest({
        ...validReleaseInput(),
        generatorVersion: CONTENT_GENERATOR_VERSION + 1,
    })

    assert.equal(CONTENT_GENERATOR_VERSION, 1)
    assert.equal(parseReleaseManifest(manifest).generatorVersion, 2)
})

test("strictly rejects malformed release manifests", () => {
    const base = validManifest()
    const table = base.tables["character.json"]
    const invalidValues = [
        null,
        [],
        { ...base, schemaVersion: 2 },
        { ...base, assetVersion: "latest" },
        { ...base, runtimeSchemaVersion: 2 },
        { ...base, generatorVersion: 0 },
        { ...base, generatorVersion: 1.5 },
        { ...base, releaseDigest: "sha256:ABC" },
        { ...base, unexpected: true },
        { ...base, tables: [] },
        { ...base, tables: { "../character.json": table } },
        { ...base, tables: { "/character.json": table } },
        { ...base, tables: { "cdndata\\character.json": table } },
        { ...base, tables: { "cdndata//character.json": table } },
        { ...base, tables: { "character": table } },
        { ...base, tables: { "character.json": { ...table, object: "a".repeat(64) } } },
        { ...base, tables: { "character.json": { ...table, scope: "client" } } },
        { ...base, tables: { "character.json": { ...table, converterId: "" } } },
        { ...base, tables: { "character.json": { ...table, converterVersion: 0 } } },
        { ...base, tables: { "character.json": { ...table, sources: "orderedmap/source" } } },
        { ...base, tables: { "character.json": { ...table, sources: ["../source"] } } },
        { ...base, tables: { "character.json": { ...table, unexpected: true } } },
        { ...base, catalog: { object: DIGEST_A, unexpected: true } },
        { ...base, summary: { object: "sha256:0" } },
    ]

    for (const value of invalidValues) {
        assert.throws(() => parseReleaseManifest(value))
    }

    const getterInput = validReleaseInput()
    Object.defineProperty(getterInput, "assetVersion", {
        enumerable: true,
        get() { return "1.4.55" },
    })
    assert.throws(() => createReleaseManifest(getterInput), /enumerable data/)
    assert.throws(() => createReleaseManifest({
        ...validReleaseInput(),
        releaseDigest: DIGEST_A,
    }), /unknown or missing fields/)
    assert.throws(() => digestReleaseManifest({
        ...base,
        unexpected: true,
    }), /unknown or missing fields/)
})

test("strictly rejects malformed or escaping current pointers", () => {
    const base = {
        schemaVersion: 1,
        assetVersion: "1.4.55",
        release: `releases/1.4.55-${DIGEST_A.slice(7)}/manifest.json`,
    }
    const invalidValues = [
        null,
        [],
        { ...base, schemaVersion: 2 },
        { ...base, assetVersion: "1.4" },
        { ...base, release: "manifest.json" },
        { ...base, release: "releases/manifest.json" },
        { ...base, release: "/releases/release/manifest.json" },
        { ...base, release: "releases/../outside/manifest.json" },
        { ...base, release: "releases\\release\\manifest.json" },
        { ...base, release: "releases/release/other.json" },
        { ...base, release: `releases/1.4.56-${DIGEST_A.slice(7)}/manifest.json` },
        { ...base, release: `releases/1.4.55-${DIGEST_A}/manifest.json` },
        { ...base, release: "releases/1.4.55-not-a-digest/manifest.json" },
        { ...base, unexpected: true },
    ]

    for (const value of invalidValues) {
        assert.throws(() => parseCurrentPointer(value))
    }
})
