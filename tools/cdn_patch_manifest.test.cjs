const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    PatchManifestError,
    parsePatchManifest,
} = require("../src/content/cdn/patch-manifest")

function archive(overrides = {}) {
    return {
        relativePath: "archive-common-diff/pinball-1.4.54-1.4.55-1-abcd.zip",
        layer: "common",
        order: 1,
        bytes: 12,
        sha256: "a".repeat(64),
        ...overrides,
    }
}

function manifest(overrides = {}) {
    return {
        schema: 1,
        baseVersion: "1.4.54",
        targetVersion: "1.4.55",
        compatibleClient: "CN 1.8.1",
        buildTool: "cdn-author-tool-v1",
        authorNotes: ["example"],
        archives: [archive()],
        ...overrides,
    }
}

function assertCode(code, run) {
    assert.throws(run, error => (
        error instanceof PatchManifestError
        && error.code === code
        && error.message.startsWith(`${code}:`)
    ))
}

test("parses runtime fields and discards top-level audit extensions", () => {
    const parsed = parsePatchManifest(manifest())

    assert.deepEqual(parsed, {
        schema: 1,
        baseVersion: "1.4.54",
        targetVersion: "1.4.55",
        compatibleClient: "CN 1.8.1",
        archives: [archive()],
    })
    assert.equal(Object.hasOwn(parsed, "buildTool"), false)
    assert.equal(Object.hasOwn(parsed, "authorNotes"), false)
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.archives), true)
    assert.equal(Object.isFrozen(parsed.archives[0]), true)
})

test("normalizes an omitted baseVersion to null but rejects explicit empty values", () => {
    const { baseVersion: _baseVersion, ...withoutBaseVersion } = manifest()

    assert.equal(parsePatchManifest(withoutBaseVersion).baseVersion, null)
    assertCode("PATCH_BASE_VERSION_INVALID", () => parsePatchManifest(manifest({ baseVersion: "" })))
    assertCode("PATCH_BASE_VERSION_INVALID", () => parsePatchManifest(manifest({ baseVersion: null })))
})

test("rejects unsupported schema, client, and unsafe numeric versions", () => {
    assertCode("PATCH_MANIFEST_SCHEMA", () => parsePatchManifest(manifest({ schema: 2 })))
    assertCode("PATCH_CLIENT_INCOMPATIBLE", () => parsePatchManifest(manifest({ compatibleClient: "JP" })))
    assertCode("PATCH_TARGET_VERSION_INVALID", () => parsePatchManifest(manifest({ targetVersion: "1.04.55" })))
    assertCode("PATCH_TARGET_VERSION_INVALID", () => parsePatchManifest(manifest({
        targetVersion: "9007199254740992.1.1",
    })))
    assertCode("PATCH_BASE_VERSION_INVALID", () => parsePatchManifest(manifest({ baseVersion: "1.04.54" })))
})

test("rejects missing, empty, or malformed archive lists", () => {
    assertCode("PATCH_ARCHIVES_INVALID", () => parsePatchManifest(manifest({ archives: [] })))
    assertCode("PATCH_ARCHIVES_INVALID", () => parsePatchManifest(manifest({ archives: "no" })))
    assertCode("PATCH_ARCHIVES_INVALID", () => parsePatchManifest(manifest({
        archives: [archive({ extra: true })],
    })))
})

test("rejects unsafe archive paths and invalid archive metadata with stable codes", () => {
    for (const relativePath of ["../x.zip", "/x.zip", "dir\\x.zip", "dir//x.zip", "dir/x.zip:ads"] ) {
        assertCode("PATCH_ARCHIVE_PATH_INVALID", () => parsePatchManifest(manifest({
            archives: [archive({ relativePath })],
        })))
    }
    assertCode("PATCH_ARCHIVE_LAYER_INVALID", () => parsePatchManifest(manifest({
        archives: [archive({ layer: "quality" })],
    })))
    assertCode("PATCH_ARCHIVE_ORDER_INVALID", () => parsePatchManifest(manifest({
        archives: [archive({ order: 0 })],
    })))
    assertCode("PATCH_ARCHIVE_SIZE_INVALID", () => parsePatchManifest(manifest({
        archives: [archive({ bytes: 0 })],
    })))
    assertCode("PATCH_ARCHIVE_SHA256_INVALID", () => parsePatchManifest(manifest({
        archives: [archive({ sha256: "A".repeat(64) })],
    })))
})

test("publishes a machine-readable schema matching the runtime manifest contract", () => {
    const schemaPath = path.resolve(__dirname, "../docs/cdn/patch-manifest.schema.json")
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"))

    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.equal(schema.$id, "https://github.com/DontBeAlarmed/startpoint-cn/blob/dev/docs/cdn/patch-manifest.schema.json")
    assert.deepEqual(schema.required, ["schema", "targetVersion", "compatibleClient", "archives"])
    assert.equal(schema.properties.schema.const, 1)
    assert.equal(schema.properties.compatibleClient.const, "CN 1.8.1")
    assert.equal(schema.properties.baseVersion.$ref, "#/$defs/version")
    assert.equal(schema.properties.targetVersion.$ref, "#/$defs/version")
    assert.equal(schema.properties.archives.minItems, 1)
    assert.equal(schema.properties.archives.items.additionalProperties, false)
    assert.deepEqual(
        schema.properties.archives.items.required,
        ["relativePath", "layer", "order", "bytes", "sha256"],
    )
    assert.deepEqual(schema.properties.archives.items.properties.layer.enum, ["common", "medium", "android"])
    assert.equal(schema.properties.archives.items.properties.order.minimum, 1)
    assert.equal(schema.properties.archives.items.properties.bytes.minimum, 1)
    assert.equal(schema.properties.archives.items.properties.sha256.pattern, "^[a-f0-9]{64}$")
})
