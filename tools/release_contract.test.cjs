const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")
const { loadServerReleaseContract } = require("./server-bundle/release-contract.cjs")

const root = path.resolve(__dirname, "..")
const fs = require("node:fs")
const os = require("node:os")

test("release contract keeps the public literal anchors", () => {
    const contract = loadServerReleaseContract(root)
    assert.equal(contract.serverManifestSchemaVersion, 3)
    assert.equal(contract.runtimeApiVersion, 1)
    assert.equal(contract.minimumDataSchema, 0)
    assert.equal(contract.currentDataSchema, 22)
    assert.equal(contract.serverEntry, "out/cn-server.js")
    assert.equal(contract.localPrepareEntry, "out/content/sync/entry.js")
    assert.equal(contract.adminPath, "web/dist")
    assert.equal(contract.bundledCdnCatalogVersion, "1.4.54")
    assert.deepEqual(contract.supportedAssetModes, ["client-owned", "local", "remote"])
    assert.deepEqual(contract.defaultPorts, { http: 8001, tcp: 8003, hub: 8004 })
})

test("release contract loader validates and isolates each project root", t => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-contract-first-"))
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-contract-second-"))
    t.after(() => {
        fs.rmSync(firstRoot, { recursive: true, force: true })
        fs.rmSync(secondRoot, { recursive: true, force: true })
    })
    fs.mkdirSync(path.join(firstRoot, "assets"))
    fs.mkdirSync(path.join(secondRoot, "assets"))
    fs.writeFileSync(path.join(firstRoot, "assets/server_release_contract.json"), JSON.stringify({
        serverManifestSchemaVersion: 3,
        runtimeApiVersion: 1,
        minimumDataSchema: 0,
        currentDataSchema: 23,
        serverEntry: "out/cn-server.js",
        localPrepareEntry: "out/content/sync/entry.js",
        adminPath: "web/dist",
        adminRequired: true,
        bundledCdnCatalogVersion: "1.4.54",
        supportedAssetModes: ["client-owned", "local", "remote"],
        defaultPorts: { http: 9001, tcp: 9003, hub: 9004 },
    }))
    assert.throws(() => loadServerReleaseContract(secondRoot), /server_release_contract\.json/)
    assert.equal(loadServerReleaseContract(firstRoot).currentDataSchema, 23)
    assert.equal(loadServerReleaseContract(firstRoot).defaultPorts.tcp, 9003)
})

test("release contract adapters reject inverted schema ranges and freeze results", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-contract-invalid-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "assets"))
    fs.writeFileSync(path.join(root, "assets/server_release_contract.json"), JSON.stringify({
        serverManifestSchemaVersion: 3,
        runtimeApiVersion: 1,
        minimumDataSchema: 0,
        currentDataSchema: 22,
        serverEntry: "out/cn-server.js",
        localPrepareEntry: "out/content/sync/entry.js",
        adminPath: "web/dist",
        adminRequired: true,
        bundledCdnCatalogVersion: "1.4.54",
        supportedAssetModes: ["client-owned", "local", "remote"],
        defaultPorts: { http: 8001, tcp: 8003, hub: 8004 },
    }))

    require("ts-node/register/transpile-only")
    const { parseServerReleaseContract } = require("../src/runtime/release-contract")
    const contract = loadServerReleaseContract(root)
    const invalidContract = { ...contract, minimumDataSchema: 1, currentDataSchema: 0 }
    fs.writeFileSync(path.join(root, "assets/server_release_contract.json"), JSON.stringify(invalidContract))
    assert.throws(() => loadServerReleaseContract(root), /minimumDataSchema must not exceed currentDataSchema/)
    assert.throws(
        () => parseServerReleaseContract(invalidContract),
        /minimumDataSchema must not exceed currentDataSchema/,
    )
    assert.equal(Object.isFrozen(contract), true)
    assert.equal(Object.isFrozen(contract.supportedAssetModes), true)
    assert.equal(Object.isFrozen(contract.defaultPorts), true)
})
