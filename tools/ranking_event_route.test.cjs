require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ranking-event-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const rankingEventRoutes = require("../src/routes/api/rankingEvent").default

initializeDatabase()
db = getDb()

function createPlayer(label, viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `ranking-event-${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)
    updatePlayerCharacterSync(playerId, 341005, { evolutionLevel: 2 })
    if (viewerId !== null) {
        db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
            .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    }
    return playerId
}

const viewerId = 800000296
const playerId = createPlayer("viewer", viewerId)
const rivalId = createPlayer("rival", null)

async function post(fastify, url, payload) {
    return fastify.inject({ method: "POST", url, payload })
}

function decode(response) {
    return unpack(response.rawPayload)
}

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(rankingEventRoutes)
    await fastify.ready()

    try {
        const empty = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 1,
            quest_kind: 1,
        })
        assert.equal(empty.statusCode, 200, empty.body)
        assert.deepEqual(decode(empty).data, { best_record: null })

        for (const payload of [
            { viewer_id: viewerId, ranking_event_id: 1, quest_kind: 2 },
            { viewer_id: viewerId, ranking_event_id: 999999, quest_kind: 1 },
        ]) {
            const response = await post(fastify, "/get_summary", payload)
            assert.equal(response.statusCode, 400)
        }

        insertPlayerQuestProgressSync(playerId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 123456,
            bestElapsedTimeMs: 1000,
            leaderCharacterId: 341005,
        })
        insertPlayerQuestProgressSync(rivalId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 999999,
            bestElapsedTimeMs: 500,
            leaderCharacterId: 341005,
        })

        const summary = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 1,
            quest_kind: 1,
        })
        assert.equal(summary.statusCode, 200, summary.body)
        assert.deepEqual(decode(summary).data, {
            best_record: {
                elapsed_time_ms: 1000,
                is_accomplished: true,
                score: 123456,
            },
            leader_character_evolution_img_level: 2,
            leader_character_id: 341005,
            rank_border_top: null,
            rank_percentage: 50,
        })

        insertPlayerQuestProgressSync(playerId, 11, {
            questId: 2001,
            finished: false,
            unlocked: true,
            highScore: 100,
            leaderCharacterId: 341005,
        })
        insertPlayerQuestProgressSync(rivalId, 11, {
            questId: 2001,
            finished: false,
            unlocked: true,
            highScore: 200,
            leaderCharacterId: 341005,
        })
        const scoreOnlySummary = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 2,
            quest_kind: 1,
        })
        assert.equal(scoreOnlySummary.statusCode, 200, scoreOnlySummary.body)
        assert.deepEqual(decode(scoreOnlySummary).data.best_record, {
            elapsed_time_ms: 0,
            is_accomplished: false,
            score: 100,
        })
        assert.equal(decode(scoreOnlySummary).data.rank_percentage, 50)

        const reward = await post(fastify, "/receive_reward", {
            viewer_id: viewerId,
            ranking_event_id: 1,
        })
        assert.equal(reward.statusCode, 404, "未实现真实发奖前不得返回 status=1")
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("ranking event route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
