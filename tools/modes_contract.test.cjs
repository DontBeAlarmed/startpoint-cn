"use strict"

// Mode seam contract: api version, deterministic ordering, conflict rules,
// missing-table semantics and the failure model. Fixture modules are written
// to a temp dir per test — nothing here ships in modes.d/.

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")

require("ts-node/register/transpile-only")

const registry = require("../src/modes/registry")
const { loadModes } = require("../src/modes/loader")

const API = registry.MODE_API_VERSION

function tempModesDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-modes-contract-"))
    test.after?.(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function installFixture(dir, fileName, source, { allowlist = true, digest } = {}) {
    fs.writeFileSync(path.join(dir, fileName), source)
    const listPath = path.join(dir, "modes-allowlist.json")
    const current = fs.existsSync(listPath)
        ? JSON.parse(fs.readFileSync(listPath, "utf8"))
        : {}
    if (allowlist) {
        current[fileName] = digest
            ?? createHash("sha256").update(Buffer.from(source)).digest("hex")
    }
    fs.writeFileSync(listPath, JSON.stringify(current))
}

function modeSource({ name, apiVersion = API, body = "", registerBody = "" }) {
    return `export const modeManifest = {
    apiVersion: ${apiVersion},
    name: ${JSON.stringify(name)},
    capability: ${JSON.stringify(name + "@1")},
}

export function register(host) {
    ${registerBody}
    return {
        ${body}
    }
}
`
}

async function load(dir, log) {
    registry.resetModesForTest()
    return loadModes({ projectRoot: dir, env: { MODES_DIR: dir }, log })
}

function hostStub(tables = {}) {
    const logs = []
    return {
        logs,
        host: {
            apiVersion: API,
            table: name => {
                if (name in tables) return tables[name]
                throw new Error(`content table is not registered: ${name}`)
            },
            log: message => logs.push(message),
            server: {},
        },
    }
}

test("refuses a mismatched module before its register() can touch a host", async () => {
    const dir = tempModesDir()
    const marker = path.join(dir, "register-ran.marker").replace(/\\/g, "/")
    // Writes a marker if register runs at all. The gate reads the static
    // manifest, so an incompatible module must never reach this point.
    const source = `import { writeFileSync } from "node:fs"

export const modeManifest = {
    apiVersion: ${API + 1},
    name: "stale",
    capability: "stale@1",
}

export function register() {
    writeFileSync(${JSON.stringify(marker)}, "ran")
    return {}
}
`
    installFixture(dir, "stale.mjs", source)
    const logs = []
    assert.deepEqual(await load(dir, m => logs.push(m)), [])
    assert.match(logs.join("\n"), /stale\.mjs.*mode API/s)
    assert.equal(fs.existsSync(marker), false, "register() must not run for a mismatched module")
})

test("refuses a module with no statically readable manifest", async () => {
    const dir = tempModesDir()
    installFixture(dir, "bare.mjs", "export function register() { return {} }\n")
    const logs = []
    assert.deepEqual(await load(dir, m => logs.push(m)), [])
    assert.match(logs.join("\n"), /bare\.mjs.*modeManifest/s)
})

test("an allowlisted module that fails to load does not stop the others", async () => {
    const dir = tempModesDir()
    installFixture(dir, "a-broken.mjs", modeSource({
        name: "broken",
        registerBody: `throw new Error("boom")`,
    }))
    installFixture(dir, "b-good.mjs", modeSource({ name: "good" }))
    const logs = []
    const loaded = await load(dir, m => logs.push(m))
    assert.deepEqual(loaded, ["good"])
    assert.match(logs.join("\n"), /a-broken\.mjs: boom/)
})

test("modules dispatch in code-point file-name order regardless of listing order", async () => {
    const dir = tempModesDir()
    for (const name of ["c", "a", "b"]) {
        installFixture(dir, `${name}.mjs`, modeSource({
            name,
            body: `onQuestStart(context, host) { host.log("start:" + ${JSON.stringify(name)}) },`,
        }))
    }
    const loaded = await load(dir, () => {})
    assert.deepEqual(loaded, ["a", "b", "c"])
    const { host, logs } = hostStub()
    registry.dispatchModeQuestStart({ playerId: 1, questId: 1, questCategory: 1 }, host)
    assert.deepEqual(logs, ["start:a", "start:b", "start:c"])
})

test("a duplicate mode name is refused and leaves the first registration intact", async () => {
    const dir = tempModesDir()
    installFixture(dir, "first.mjs", modeSource({ name: "same" }))
    installFixture(dir, "second.mjs", modeSource({ name: "same" }))
    const logs = []
    const loaded = await load(dir, m => logs.push(m))
    assert.deepEqual(loaded, ["same"])
    assert.match(logs.join("\n"), /second\.mjs.*already registered/s)
})

test("host.table serves base-registered tables and refuses anything else", () => {
    const { host } = hostStub({ "character.json": { ok: true } })
    assert.deepEqual(host.table("character.json"), { ok: true })
    // Mode-private tables are not hosted here; a mode's own switches belong
    // in its manifest or its own files.
    assert.throws(() => host.table("mode_private.json"), /not registered/)
})

test("quest start is a veto chain: first throw wins and later modules are skipped", async () => {
    const dir = tempModesDir()
    installFixture(dir, "a-veto.mjs", modeSource({
        name: "veto",
        body: `onQuestStart() { throw new Error("entry denied") },`,
    }))
    installFixture(dir, "b-after.mjs", modeSource({
        name: "after",
        body: `onQuestStart(context, host) { host.log("should-not-run") },`,
    }))
    await load(dir, () => {})
    const { host, logs } = hostStub()
    assert.throws(
        () => registry.dispatchModeQuestStart({ playerId: 1, questId: 1, questCategory: 1 }, host),
        /entry denied/,
    )
    assert.deepEqual(logs, [])
})

test("settlement propagates so the enclosing transaction rolls back", async () => {
    const dir = tempModesDir()
    installFixture(dir, "a-bad.mjs", modeSource({
        name: "bad",
        body: `onRushFinish() { throw new Error("settlement bug") },`,
    }))
    await load(dir, () => {})
    const { host } = hostStub()
    // The hook runs inside the finish transaction: swallowing here would let
    // a module's partial writes commit, so the throw must reach the caller.
    assert.throws(() => registry.dispatchModeRushFinish({}, host), /settlement bug/)
})

test("settlement concatenates rewards from every module in registration order", async () => {
    const dir = tempModesDir()
    installFixture(dir, "a-first.mjs", modeSource({
        name: "first",
        body: `onRushFinish() {
            return { rush_battle_reward_list: [{ kind: 1, kind_id: 1, number: 1 }] }
        },`,
    }))
    installFixture(dir, "b-second.mjs", modeSource({
        name: "second",
        body: `onRushFinish() {
            return { rush_battle_reward_list: [{ kind: 6, kind_id: 2, number: 3 }] }
        },`,
    }))
    await load(dir, () => {})
    const { host } = hostStub()
    assert.deepEqual(registry.dispatchModeRushFinish({}, host), {
        rush_battle_reward_list: [
            { kind: 1, kind_id: 1, number: 1 },
            { kind: 6, kind_id: 2, number: 3 },
        ],
    })
})

test("played-party rewrites compose across modules and survive a faulty one", async () => {
    const dir = tempModesDir()
    installFixture(dir, "a-throws.mjs", modeSource({
        name: "thrower",
        body: `onRushPartiesSerialized() { throw new Error("rewrite bug") },`,
    }))
    installFixture(dir, "b-clears.mjs", modeSource({
        name: "clearer",
        body: `onRushPartiesSerialized(context) {
            for (const party of Object.values(context.folderParties)) party.character_id_1 = null
        },`,
    }))
    await load(dir, () => {})
    const { host, logs } = hostStub()
    const context = {
        playerId: 1, eventId: 700099,
        folderParties: { 1: { character_id_1: 42, round: 1 } }, endlessParties: {},
    }
    registry.dispatchModeRushParties(context, host)
    assert.equal(context.folderParties[1].character_id_1, null)
    assert.equal(context.folderParties[1].round, 1)
    assert.match(logs.join("\n"), /thrower failed and was skipped: rewrite bug/)
})

test("with no modules installed every dispatch is a no-op", () => {
    registry.resetModesForTest()
    const { host, logs } = hostStub()
    const context = {
        playerId: 1, eventId: 1,
        folderParties: { 1: { character_id_1: 42 } }, endlessParties: {},
    }
    assert.equal(registry.dispatchModeRushFinish({}, host), null)
    registry.dispatchModeQuestStart({ playerId: 1, questId: 1, questCategory: 1 }, host)
    registry.dispatchModeRushParties(context, host)
    assert.equal(context.folderParties[1].character_id_1, 42)
    assert.deepEqual(logs, [])
    assert.deepEqual(registry.listModeCapabilities(), [])
})
