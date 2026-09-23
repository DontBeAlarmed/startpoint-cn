const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { EventEmitter } = require("node:events")
const { sessionManager } = require("../src/multi/state/SessionManager")

// The CN client drives lobby (cooperation_room) and battle
// (cooperation_battle) as independent sockets; the server never modeled a
// single per-connection client lifecycle. ClientStateMachine only ever moved
// Connecting -> Handshaking and was never read; SessionClient.battleState was
// initialized and never transitioned or consumed. Both dead models were
// removed; this keeps them from creeping back and pins the socket shape.
const MULTI_SOURCE_DIRS = ["state", "tcp", "coordinator", "room", "settlement", "http", "npc"]

function listSourceFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...listSourceFiles(full))
        else if (entry.name.endsWith(".ts")) files.push(full)
    }
    return files
}

test("multi sources no longer reference the removed client/battle state models", () => {
    const root = path.join(__dirname, "../src/multi")
    const files = MULTI_SOURCE_DIRS.flatMap(dir => {
        const full = path.join(root, dir)
        return fs.existsSync(full) ? listSourceFiles(full) : []
    })
    assert.ok(files.length > 10, "source scan must cover the multi module")

    for (const file of files) {
        const source = fs.readFileSync(file, "utf8")
        assert.equal(
            /\bClientStateMachine\b/.test(source), false,
            `${file} must not use the removed ClientStateMachine`,
        )
        assert.equal(
            /\bClientState\b/.test(source), false,
            `${file} must not use the removed ClientState enum`,
        )
        assert.equal(
            /\bBattleState\b/.test(source), false,
            `${file} must not use the removed BattleState enum (BattleStatus is the wire contract)`,
        )
    }

    assert.equal(
        fs.existsSync(path.join(__dirname, "../src/multi/state/ClientStateMachine.ts")),
        false,
        "the dead ClientStateMachine module must stay deleted",
    )
})

test("a fresh session client carries no per-connection lifecycle state", () => {
    const socket = new EventEmitter()
    socket.writable = true
    const client = sessionManager.createClient(socket, 700001, "dead-state-room", "dead-state-cid")
    assert.equal("clientState" in client, false)
    assert.equal("battleState" in client, false)
})
