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

// A real bundled rush quest: this route resolves quests through the
// repo-bundled asset, not the content snapshot.
const QUEST_ID = 700001001
const QUEST_CATEGORY = 24 // QuestCategory.RUSH_EVENT

const tables = {}

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "test" },
    repository: {
        info: () => ({
            source: "release",
            assetVersion: "test",
            generatorVersion: 1,
            releaseDigest: "sha256:test",
        }),
        table: tableName => {
            if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
            return tables[tableName]
        },
    },
}
restoreSnapshot = () => {
    productionContentSnapshotProvider.snapshot = previousSnapshot
}

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

function readPlayerName() {
    return db.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name
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

        // --- without the module the same request is not vetoed ----------
        registry.resetModesForTest()
        const notVetoed = await post(fastify, "start", startBody())
        assert.notEqual(
            replyMessage(notVetoed),
            "blocked by fixture module",
            "no module installed → the seam must not reject the start",
        )

        // --- /finish settlement fault rolls the transaction back --------
        const rollbackDir = tempModesDir("wf-modes-route-rollback-")
        installModule(rollbackDir, "rollback.mjs", "rollback-fixture",
            `onRushFinish() { throw new Error("settlement fixture fault") },`)
        assert.deepEqual(await bootModes(rollbackDir), ["rollback-fixture"])

        const before = readPlayerName()
        const finished = await post(fastify, "finish", {
            is_restored: false,
            continue_count: 0,
            elapsed_time_ms: 1000,
            quest_id: QUEST_ID,
            category: QUEST_CATEGORY,
            score: 0,
            viewer_id: viewerId,
            add_mana: 10,
            is_accomplished: true,
            statistics: {
                clear_phase: 1,
                party: {
                    characters: [], unison_characters: [], equipments: [],
                    ability_soul_ids: [],
                },
            },
            api_count: 2,
        })
        // Whatever the route reports, the invariant is that a module fault
        // inside the settlement transaction leaves no partial player state.
        assert.notEqual(finished.statusCode, 200, finished.body)
        assert.equal(readPlayerName(), before, "settlement must have rolled back")

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
