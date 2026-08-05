"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-load-recovery-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["mission_active.json", "mission_active_event.json"],
})
const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    activeQuests,
    insertActiveQuest,
    runAbortActiveQuestTransaction,
} = require("../src/lib/quest/active-quest-service")
const { MultiSettlementVerifier } = require("../src/multi/settlement/verifier")
const {
    isValidBattleSessionId,
    isValidMultiRoomNumber,
} = require("../src/multi/coordinator/contracts")
const { RemoteMultiCoordinator } = require("../src/multi/coordinator/remote")
const { HubClient } = require("../src/multi/hub/client")
const cnLoadRoutes = require("../src/routes/cn/load").default

const VIEWER_ID = 101
const QUEST = Object.freeze({ category: 13, questId: 2001, ticketId: 500000 })
const VALID_BATTLE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174001"

test.after(() => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

function activeQuest(label, overrides = {}) {
    return {
        questId: QUEST.questId,
        category: QUEST.category,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: true,
        roomNumber: "123456",
        battleSessionId: VALID_BATTLE_SESSION_ID,
        entryItemId: QUEST.ticketId,
        entryItemCount: 2,
        eventId: null,
        playId: `play-${label}`,
        continueCount: 0,
        ...overrides,
    }
}

test("stored identity validators match generated room numbers and UUID v4 battle sessions", () => {
    assert.equal(typeof isValidMultiRoomNumber, "function")
    assert.equal(typeof isValidBattleSessionId, "function")
    for (const value of ["100000", "123456", "999998"]) {
        assert.equal(isValidMultiRoomNumber(value), true, value)
    }
    for (const value of ["99999", "012345", "9999999", "abcdef", "12345\n"]) {
        assert.equal(isValidMultiRoomNumber(value), false, value)
    }
    assert.equal(isValidBattleSessionId(VALID_BATTLE_SESSION_ID), true)
    for (const value of [
        "00000000-0000-1000-8000-000000000001",
        VALID_BATTLE_SESSION_ID.toUpperCase(),
        `${VALID_BATTLE_SESSION_ID}\n`,
        "battle-session",
    ]) {
        assert.equal(isValidBattleSessionId(value), false, value)
    }
})

async function openHome(label, quest) {
    closeDatabase()
    process.env.DATA_DIR = path.join(databaseRoot, label)
    initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(
        String(VIEWER_ID),
        account.id,
        new Date("2099-12-31T23:59:59.000Z").toISOString(),
    )
    givePlayerItemSync(playerId, QUEST.ticketId, 3)
    if (quest) insertActiveQuest(playerId, quest)
    return { accountId: account.id, playerId }
}

async function buildLoadApp(verifier, multiMode = "client") {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        multiMode,
        multiRecoveryVerifier: verifier,
    })
    await app.ready()
    return app
}

async function load(app) {
    const response = await app.inject({
        method: "POST",
        url: "/load",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            res_ver: "1.4.54",
        },
        payload: pack({
            viewer_id: VIEWER_ID,
            keychain: VIEWER_ID,
            device_id: 1,
            device_token: "bounded-test-device",
        }).toString("base64"),
    })
    return {
        response,
        payload: response.statusCode === 200
            ? unpack(Buffer.from(response.body, "base64"))
            : null,
    }
}

function unfinished(payload, quest) {
    assert.deepEqual(payload.data.unfinished_multi_quest_list, [{
        play_id: quest.playId,
        continue_count: quest.continueCount,
    }])
}

for (const state of ["active", "finalized", "unavailable"]) {
    test(`load preserves and publishes a remote ${state} active quest`, async t => {
        const quest = activeQuest(state)
        const home = await openHome(`preserve-${state}`, quest)
        const calls = []
        const verifier = {
            inspect: async input => {
                calls.push(structuredClone(input))
                return state === "unavailable"
                    ? { state, code: "HUB_UNAVAILABLE" }
                    : { state }
            },
        }
        const app = await buildLoadApp(verifier)
        t.after(async () => {
            delete activeQuests[home.playerId]
            await app.close()
        })

        const result = await load(app)

        assert.equal(result.response.statusCode, 200, result.response.body)
        unfinished(result.payload, quest)
        assert.deepEqual(calls, [{
            nodeSessionId: "remote-pending",
            viewerId: VIEWER_ID,
            roomNumber: quest.roomNumber,
            battleSessionId: quest.battleSessionId,
        }])
        assert.equal(getPlayerActiveQuestSync(home.playerId).playId, quest.playId)
        assert.equal(activeQuests[home.playerId].playId, quest.playId)
        assert.equal(getPlayerItemSync(home.playerId, QUEST.ticketId), 3)
        assert.equal(getDb().prepare(
            "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
        ).get(home.playerId).count, 0)
    })
}

for (const [role, entry] of [
    ["host", { entryItemId: QUEST.ticketId, entryItemCount: 2, expectedItems: 5 }],
    ["guest", { entryItemId: null, entryItemCount: null, expectedItems: 3 }],
]) {
    test(`authoritative missing atomically aborts ${role} without rewards`, async t => {
        const quest = activeQuest(`missing-${role}`, entry)
        const home = await openHome(`missing-${role}`, quest)
        const app = await buildLoadApp({ inspect: async () => ({ state: "missing" }) })
        t.after(async () => {
            delete activeQuests[home.playerId]
            await app.close()
        })

        const result = await load(app)

        assert.equal(result.response.statusCode, 200, result.response.body)
        assert.deepEqual(result.payload.data.unfinished_multi_quest_list, [])
        assert.equal(getPlayerActiveQuestSync(home.playerId), null)
        assert.equal(activeQuests[home.playerId], undefined)
        assert.equal(getPlayerItemSync(home.playerId, QUEST.ticketId), entry.expectedItems)
        assert.equal(getDb().prepare(
            "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
        ).get(home.playerId).count, 0)
    })
}

test("concurrent missing load and abort refund a stored cost once", async t => {
    const quest = activeQuest("concurrent-missing")
    const home = await openHome("concurrent-missing", quest)
    let release
    const reached = new Promise(resolve => { release = resolve })
    const app = await buildLoadApp({
        inspect: async () => {
            await reached
            return { state: "missing" }
        },
    })
    t.after(async () => {
        delete activeQuests[home.playerId]
        await app.close()
    })

    const pendingLoad = load(app)
    const aborted = runAbortActiveQuestTransaction(home.playerId, quest)
    release()
    const loaded = await pendingLoad

    assert.equal(aborted.cancelled, true)
    assert.equal(loaded.response.statusCode, 200, loaded.response.body)
    assert.equal(getPlayerActiveQuestSync(home.playerId), null)
    assert.equal(getPlayerItemSync(home.playerId, QUEST.ticketId), 5)
})

test("malformed stored remote identities never reach Hub or mutate the save", async () => {
    const absolutePath = path.join(path.sep, "private", "tmp", "multi-identity")
    const cases = [
        ["room-missing", { roomNumber: null }],
        ["room-absolute", { roomNumber: absolutePath }],
        ["room-control", { roomNumber: "12345\0" }],
        ["room-overlong", { roomNumber: "1".repeat(65) }],
        ["room-format", { roomNumber: "12345" }],
        ["battle-absolute", { battleSessionId: absolutePath }],
        ["battle-control", { battleSessionId: `${VALID_BATTLE_SESSION_ID}\0` }],
        ["battle-overlong", { battleSessionId: "a".repeat(129) }],
        ["battle-format", { battleSessionId: "battle-session" }],
    ]
    const fixedWarning = "[CN-LOAD] multi recovery skipped code=MULTI_RECOVERY_INVALID_IDENTITY"

    for (const [label, overrides] of cases) {
        const quest = activeQuest(label, overrides)
        const home = await openHome(`malformed-${label}`, quest)
        let verifierCalls = 0
        const warnings = []
        const originalWarn = console.warn
        console.warn = (...args) => warnings.push(args.join(" "))
        const app = await buildLoadApp({
            inspect: async () => {
                verifierCalls++
                return { state: "missing" }
            },
        })
        try {
            const result = await load(app)

            assert.equal(result.response.statusCode, 200, `${label}: ${result.response.body}`)
            unfinished(result.payload, quest)
            assert.equal(verifierCalls, 0, label)
            assert.equal(getPlayerActiveQuestSync(home.playerId).playId, quest.playId, label)
            assert.equal(getPlayerItemSync(home.playerId, QUEST.ticketId), 3, label)
            assert.deepEqual(warnings, [fixedWarning], label)
        } finally {
            console.warn = originalWarn
            delete activeQuests[home.playerId]
            await app.close()
        }
    }
})

test("legacy multi quest without battle identity keeps local missing-room recovery", async t => {
    const quest = activeQuest("legacy", { battleSessionId: null, roomNumber: "999999" })
    const home = await openHome("legacy", quest)
    let verifierCalls = 0
    const app = await buildLoadApp({ inspect: async () => { verifierCalls++; return { state: "active" } } }, "embedded")
    t.after(async () => {
        delete activeQuests[home.playerId]
        await app.close()
    })

    const result = await load(app)

    assert.equal(result.response.statusCode, 200, result.response.body)
    assert.equal(verifierCalls, 0)
    assert.equal(getPlayerActiveQuestSync(home.playerId), null)
    assert.equal(getPlayerItemSync(home.playerId, QUEST.ticketId), 5)
})

test("load without a recoverable battle identity never awaits the verifier", async t => {
    await openHome("no-active-quest", null)
    let verifierCalls = 0
    const app = await buildLoadApp({
        inspect: async () => {
            verifierCalls++
            return new Promise(() => {})
        },
    })
    t.after(() => app.close())

    const result = await Promise.race([
        load(app),
        new Promise((_, reject) => setTimeout(() => reject(new Error("load awaited verifier")), 250)),
    ])

    assert.equal(result.response.statusCode, 200, result.response.body)
    assert.equal(verifierCalls, 0)
})

test("401, network, timeout, and invalid JSON are unavailable, never missing", async () => {
    const scenarios = {
        unauthorized: async () => new Response("{}", { status: 401 }),
        network: async () => { throw new Error("network down") },
        timeout: async (_url, init) => new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        }),
        invalidJson: async () => new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    }

    for (const [name, fetch] of Object.entries(scenarios)) {
        const verifier = new MultiSettlementVerifier(new RemoteMultiCoordinator(new HubClient({
            hubUrl: new URL("http://hub.example/"),
            token: "a".repeat(32),
            timeoutMs: 10,
            fetch,
        })))
        assert.deepEqual(await verifier.inspect({
            nodeSessionId: "remote-pending",
            viewerId: VIEWER_ID,
            roomNumber: "123456",
            battleSessionId: VALID_BATTLE_SESSION_ID,
        }), { state: "unavailable", code: "HUB_UNAVAILABLE" }, name)
    }
})
