const assert = require("node:assert/strict")
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
        generator: "starpoint-cn-gacha-patch-v1",
        targetGachaIds: [44],
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
    assert.equal(Object.hasOwn(parsed, "generator"), false)
    assert.equal(Object.hasOwn(parsed, "targetGachaIds"), false)
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
