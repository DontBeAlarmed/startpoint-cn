require("ts-node/register/transpile-only")

// Route-level proof that the seam is reachable through the real HTTP
// handlers: an installed module must be able to veto /start and, when it
// throws during /finish settlement, the whole transaction must roll back.
// Fixture modules live in a temp dir — modes.d/ ships empty.

const assert = require("node:assert/strict")
const { createHash, randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-modes-routes-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreSnapshot = () => {}
let restoreTime = () => {}
const tempDirs = []

function cleanup() {
    if (db?.open) db.close()
    restoreSnapshot()
    restoreTime()
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

// A real bundled rush quest installed through the same gameplay snapshot
// contract used by the runtime.
const QUEST_ID = 700001001
const QUEST_CATEGORY = 24 // QuestCategory.RUSH_EVENT

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreSnapshot = installBundledGameplaySnapshot()

const { activeQuests } = require("../src/lib/quest/active-quest-service")
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const registry = require("../src/modes/registry")
const { initializeContentAndModes } = require("../src/modes/boot")
const singleBattleQuestRoutes = require("../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `modes-routes-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000731
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function tempModesDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
}

function installModule(dir, fileName, name, body) {
    const source = `export const modeManifest = {
    apiVersion: ${registry.MODE_API_VERSION},
    name: ${JSON.stringify(name)},
    capability: ${JSON.stringify(name + "@1")},
}

export function register() {
    return {
        ${body}
    }
}
`
    fs.writeFileSync(path.join(dir, fileName), source)
    fs.writeFileSync(
        path.join(dir, "modes-allowlist.json"),
        JSON.stringify({
            [fileName]: createHash("sha256").update(Buffer.from(source)).digest("hex"),
        }),
    )
}

/** Boots through the same composition cn-server gives the coordinator. */
async function bootModes(dir) {
    registry.resetModesForTest()
    return initializeContentAndModes({
        projectRoot: dir,
        initializeContentSnapshot: async () => {},
        env: { MODES_DIR: dir },
        log: () => {},
    })
}

async function buildServer() {
    const fastify = Fastify()
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(singleBattleQuestRoutes, {
        prefix: "/api/index.php/single_battle_quest",
    })
    await fastify.ready()
    return fastify
}

function post(fastify, route, body) {
    return fastify.inject({
        method: "POST",
        url: `/api/index.php/single_battle_quest/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
}

const ROLLBACK_MARKER = "settlement-fixture-fault-4f2a"

function finishBody() {
    return {
        is_restored: false,
        continue_count: 0,
        elapsed_time_ms: 1000,
        quest_id: QUEST_ID,
        category: QUEST_CATEGORY,
        score: 100,
        viewer_id: viewerId,
        add_mana: 50,
        is_accomplished: true,
        statistics: {
            clear_phase: 1,
            party: {
                characters: [], unison_characters: [], equipments: [],
                ability_soul_ids: [],
            },
        },
        api_count: 2,
    }
}

function startBody() {
    return {
        quest_id: QUEST_ID,
        use_boss_boost_point: false,
        use_boost_point: false,
        category: QUEST_CATEGORY,
        viewer_id: viewerId,
        play_id: randomUUID(),
        is_auto_start_mode: false,
        party_id: 1,
        api_count: 1,
    }
}

/** Error replies are JSON; success replies are base64 msgpack. */
function replyMessage(response) {
    try {
        return JSON.parse(response.body).message
    } catch {
        return undefined
    }
}

function decodeSuccess(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

/**
 * State a normal rush settlement is guaranteed to move, so asserting it is
 * unchanged actually proves the settlement did not commit. players.name is
 * useless here — settlement never writes it.
 */
function settlementState() {
    const player = db
        .prepare("SELECT total_mana_obtained, free_mana FROM players WHERE id = ?")
        .get(playerId)
    const progress = db
        .prepare("SELECT COUNT(*) AS rows FROM players_quest_progress WHERE player_id = ?")
        .get(playerId)
    return {
        totalManaObtained: player.total_mana_obtained ?? 0,
        freeMana: player.free_mana ?? 0,
        questProgressRows: progress.rows,
    }
}

async function main() {
    const fastify = await buildServer()
    try {
        // --- /start veto reaches the client -----------------------------
        const vetoDir = tempModesDir("wf-modes-route-veto-")
        installModule(vetoDir, "veto.mjs", "veto-fixture",
            `onQuestStart() { throw new Error("blocked by fixture module") },`)
        assert.deepEqual(await bootModes(vetoDir), ["veto-fixture"])

        const vetoed = await post(fastify, "start", startBody())
        assert.equal(vetoed.statusCode, 400, vetoed.body)
        assert.equal(replyMessage(vetoed), "blocked by fixture module")

        // --- without a module /start must actually succeed ---------------
        // Asserting "no such error message" would also pass on a 500, so
        // assert the success itself: status, decoded payload and the active
        // quest the route is required to create.
        registry.resetModesForTest()
        delete activeQuests[playerId]
        const started = await post(fastify, "start", startBody())
        assert.equal(started.statusCode, 200, started.body)
        const startPayload = decodeSuccess(started)
        assert.ok(startPayload.data_headers, "success reply carries data_headers")
        assert.equal(startPayload.data_headers.result_code, 1)
        assert.ok(startPayload.data, "success reply carries a data section")
        assert.ok(activeQuests[playerId], "a successful start must create the active quest")
        assert.equal(activeQuests[playerId].questId, QUEST_ID)

        // --- /finish settlement fault rolls real settlement state back ---
        const rollbackDir = tempModesDir("wf-modes-route-rollback-")
        installModule(rollbackDir, "rollback.mjs", "rollback-fixture",
            `onRushFinish() { throw new Error("${ROLLBACK_MARKER}") },`)
        assert.deepEqual(await bootModes(rollbackDir), ["rollback-fixture"])

        // The active quest from the successful start above is the valid
        // precondition for finishing.
        assert.ok(activeQuests[playerId], "finish needs the active quest from /start")
        const before = settlementState()

        const finished = await post(fastify, "finish", finishBody())

        // The response must be traceable to the fixture's unique error, which
        // is what proves the handler reached the hook at all.
        const failureText = `${finished.statusCode} ${finished.body}`
        assert.ok(
            failureText.includes(ROLLBACK_MARKER),
            `finish must fail with the fixture error; got ${failureText}`,
        )
        assert.deepEqual(
            settlementState(),
            before,
            "settlement state a normal finish would change must be unchanged",
        )
        assert.ok(
            activeQuests[playerId],
            "a failed settlement must not consume the active quest",
        )

        // --- control: retrying the same finish without a module settles --
        // Without this, "state unchanged" could pass vacuously if the chosen
        // state simply never moves during settlement.
        registry.resetModesForTest()
        const beforeControl = settlementState()
        const controlFinish = await post(fastify, "finish", finishBody())
        assert.equal(controlFinish.statusCode, 200, controlFinish.body)
        assert.notDeepEqual(
            settlementState(),
            beforeControl,
            "a normal settlement must move the state the rollback assertion watches",
        )

        console.log("modes route-level checks passed")
    } finally {
        registry.resetModesForTest()
        await fastify.close()
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
