"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { loadModes } = require("../src/modes/loader")
const {
    dispatchModeQuestStart,
    dispatchModeRushFinish,
    listModeCapabilities,
    registerMode,
    resetModesForTest,
} = require("../src/modes/registry")

const MODULE_SOURCE = `export function register(host) {
    return {
        name: "fixture-mode",
        capability: "fixture@1",
        onRushFinish() { return { rush_battle_reward_list: [{ kind: 1, kind_id: 5, number: 2 }] } },
        onQuestStart(context) { if (context.questId === 999) throw new Error("blocked by fixture") },
    }
}
`

function makeModesDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modes-test-"))
    const allowlist = {}
    for (const [name, { source, allow }] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), source)
        if (allow) {
            allowlist[name] = crypto.createHash("sha256").update(source).digest("hex")
        }
    }
    fs.writeFileSync(path.join(dir, "modes-allowlist.json"), JSON.stringify(allowlist))
    return dir
}

test("loader loads allowlisted modules and registers handlers", async t => {
    resetModesForTest()
    t.after(resetModesForTest)
    const dir = makeModesDir({ "fixture.mjs": { source: MODULE_SOURCE, allow: true } })
    const logs = []
    const loaded = await loadModes({
        projectRoot: "/nonexistent",
        env: { MODES_DIR: dir },
        log: message => logs.push(message),
    })
    assert.deepEqual(loaded, ["fixture-mode"])
    assert.deepEqual(listModeCapabilities(), ["fixture@1"])
    const extension = dispatchModeRushFinish({}, { table: () => ({}), log: () => {} })
    assert.deepEqual(extension, {
        rush_battle_reward_list: [{ kind: 1, kind_id: 5, number: 2 }],
    })
    assert.throws(
        () => dispatchModeQuestStart(
            { playerId: 1, questId: 999, questCategory: 18 },
            { table: () => ({}), log: () => {} },
        ),
        /blocked by fixture/,
    )
})

test("loader skips unregistered and hash-mismatched modules", async t => {
    resetModesForTest()
    t.after(resetModesForTest)
    const dir = makeModesDir({
        "unlisted.mjs": { source: MODULE_SOURCE, allow: false },
        "tampered.mjs": { source: MODULE_SOURCE, allow: true },
    })
    fs.appendFileSync(path.join(dir, "tampered.mjs"), "// tampered\n")
    const logs = []
    const loaded = await loadModes({
        projectRoot: "/nonexistent",
        env: { MODES_DIR: dir },
        log: message => logs.push(message),
    })
    assert.deepEqual(loaded, [])
    assert.ok(logs.some(line => line.includes("SKIP unlisted.mjs")))
    assert.ok(logs.some(line => line.includes("SKIP tampered.mjs")))
    assert.equal(dispatchModeRushFinish({}, { table: () => ({}), log: () => {} }), null)
})

test("MODES_ENABLED=0 disables loading; missing dir is a silent no-op", async t => {
    resetModesForTest()
    t.after(resetModesForTest)
    const dir = makeModesDir({ "fixture.mjs": { source: MODULE_SOURCE, allow: true } })
    assert.deepEqual(await loadModes({
        projectRoot: "/nonexistent",
        env: { MODES_DIR: dir, MODES_ENABLED: "0" },
        log: () => {},
    }), [])
    assert.deepEqual(await loadModes({
        projectRoot: path.join(os.tmpdir(), "no-such-root-" + Date.now()),
        env: {},
        log: () => {},
    }), [])
})

test("registry rejects duplicate and malformed registrations", t => {
    resetModesForTest()
    t.after(resetModesForTest)
    registerMode({ name: "a", capability: "a@1" })
    assert.throws(() => registerMode({ name: "a", capability: "a@2" }), /already registered/)
    assert.throws(() => registerMode({ name: "", capability: "x" }), /requires a name/)
})
