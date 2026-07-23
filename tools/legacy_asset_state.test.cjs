"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const modulePath = path.join(projectRoot, "src/routes/api/legacy-asset-state.ts")

function temporaryLayout(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-asset-state-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const cdnDir = path.join(root, "cdn")
    const modsDir = path.join(cdnDir, "mods")
    const assetProviderDir = path.join(root, "data", "asset-provider")
    const metadataFile = path.join(assetProviderDir, "legacy-metadata.json")
    fs.mkdirSync(modsDir, { recursive: true })
    return { root, cdnDir, modsDir, assetProviderDir, metadataFile }
}

function requireStateModule() {
    assert.equal(fs.existsSync(modulePath), true, "legacy asset state module must exist")
    return require(modulePath)
}

test("legacy asset state publishes changed mods once and exposes the new version", t => {
    const layout = temporaryLayout(t)
    fs.writeFileSync(path.join(layout.modsDir, "fixture.zip"), "first mod")
    const { loadLegacyAssetState } = requireStateModule()

    const first = loadLegacyAssetState(layout)
    const second = loadLegacyAssetState(layout)

    assert.equal(first.availableAssetVersion, "2.1.126")
    assert.equal(second.availableAssetVersion, "2.1.126")
    assert.equal(first.metadata.mods.length, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(layout.metadataFile, "utf8")), first.metadata)
})

test("legacy asset state never follows a metadata target symlink", t => {
    const layout = temporaryLayout(t)
    fs.mkdirSync(layout.assetProviderDir, { recursive: true })
    fs.writeFileSync(path.join(layout.modsDir, "fixture.zip"), "changed mod")
    const victim = path.join(layout.root, "victim.json")
    fs.writeFileSync(victim, "do not replace")
    fs.symlinkSync(victim, layout.metadataFile)
    const { loadLegacyAssetState } = requireStateModule()

    assert.throws(() => loadLegacyAssetState(layout), /regular file|symbolic link/i)
    assert.equal(fs.readFileSync(victim, "utf8"), "do not replace")
})

test("legacy asset state rejects a symlinked asset provider directory", t => {
    const layout = temporaryLayout(t)
    const external = path.join(layout.root, "external")
    fs.mkdirSync(path.dirname(layout.assetProviderDir), { recursive: true })
    fs.mkdirSync(external)
    fs.rmSync(layout.assetProviderDir, { recursive: true, force: true })
    fs.symlinkSync(external, layout.assetProviderDir)
    fs.writeFileSync(path.join(layout.modsDir, "fixture.zip"), "changed mod")
    const { loadLegacyAssetState } = requireStateModule()

    assert.throws(() => loadLegacyAssetState(layout), /directory|symbolic link/i)
    assert.deepEqual(fs.readdirSync(external), [])
})

test("global server initializes asset state and binds serialization to its getter", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src/server.ts"), "utf8")

    assert.match(source, /initializeLegacyAssetState\(\)/)
    assert.match(source, /configureSerializedAssetVersionProvider\(getLegacyAvailableAssetVersion\)/)
})
