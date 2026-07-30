require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rush-reset-route-db-"))
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
    getDefaultPlayerRushEventSync,
    getPlayerRushEventPlayedPartiesSync,
    getPlayerRushEventSync,
    insertPlayerRushEventPlayedPartySync,
    insertPlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { RushEventBattleType } = require("../src/data/types")
const rushEventRoutes = require("../src/routes/api/rushEvent").default

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `rush-reset-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000297
const eventId = 700001
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function insertEvent() {
    const event = getDefaultPlayerRushEventSync(eventId)
    event.activeRushBattleFolderId = 1
    insertPlayerRushEventSync(playerId, event)
}

function insertParty(round, battleType) {
    insertPlayerRushEventPlayedPartySync(playerId, eventId, {
        characterIds: [null, null, null],
        unisonCharacterIds: [null, null, null],
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        evolutionImgLevels: [null, null, null],
        unisonEvolutionImgLevels: [null, null, null],
        round,
        battleType,
    })
}

function playedKeys() {
    return getPlayerRushEventPlayedPartiesSync(playerId, eventId)
        .map(entry => `${entry.battleType}:${entry.round}`)
        .sort()
}

async function postReset(fastify, body) {
    return fastify.inject({
        method: "POST",
        url: "/reset",
        payload: { viewer_id: viewerId, event_id: eventId, ...body },
    })
}

async function main() {
    insertEvent()
    insertParty(700001001, RushEventBattleType.FOLDER)
    insertParty(700001002, RushEventBattleType.FOLDER)
    insertParty(700001003, RushEventBattleType.FOLDER)
    insertParty(1, RushEventBattleType.ENDLESS)
    insertParty(2, RushEventBattleType.ENDLESS)
    insertParty(3, RushEventBattleType.ENDLESS)

    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(rushEventRoutes)
    await fastify.ready()

    try {
        for (const body of [
            { quest_type: 0 },
            { quest_type: 3 },
            { quest_type: 1, reset_target_id: 700002001 },
            { quest_type: 1, reset_target_id: 700001007 },
            { quest_type: 2, reset_target_id: 0, is_reset_after_target_round: false },
            { quest_type: 2, reset_target_id: 2 },
            { quest_type: 2, reset_target_id: 2, is_reset_after_target_round: 1 },
        ]) {
            const before = playedKeys()
            const response = await postReset(fastify, body)
            assert.equal(response.statusCode, 400, JSON.stringify(body))
            assert.deepEqual(playedKeys(), before, `非法请求不得改动状态: ${JSON.stringify(body)}`)
        }

        const partialFolder = await postReset(fastify, {
            quest_type: 1,
            reset_target_id: 700001002,
        })
        assert.equal(partialFolder.statusCode, 200, partialFolder.body)
        assert.deepEqual(playedKeys(), ["0:700001001", "0:700001003", "1:1", "1:2", "1:3"])
        assert.equal(getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId, 1)

        const singleEndless = await postReset(fastify, {
            quest_type: 2,
            reset_target_id: 2,
            is_reset_after_target_round: false,
        })
        assert.equal(singleEndless.statusCode, 200, singleEndless.body)
        assert.deepEqual(playedKeys(), ["0:700001001", "0:700001003", "1:1", "1:3"])

        insertParty(2, RushEventBattleType.ENDLESS)
        const trailingEndless = await postReset(fastify, {
            quest_type: 2,
            reset_target_id: 2,
            is_reset_after_target_round: true,
        })
        assert.equal(trailingEndless.statusCode, 200, trailingEndless.body)
        assert.deepEqual(playedKeys(), ["0:700001001", "0:700001003", "1:1"])

        db.exec(`
            CREATE TRIGGER fail_rush_folder_party_delete
            BEFORE DELETE ON players_rush_events_played_parties
            WHEN OLD.battle_type = 0
            BEGIN
                SELECT RAISE(ABORT, 'injected rush reset rollback');
            END;
        `)
        const failedGiveUp = await postReset(fastify, { quest_type: 1 })
        assert.equal(failedGiveUp.statusCode, 500)
        assert.equal(
            getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId,
            1,
            "删除已用队伍失败时，活动文件夹选择也必须回滚",
        )
        assert.deepEqual(playedKeys(), ["0:700001001", "0:700001003", "1:1"])
        db.exec("DROP TRIGGER fail_rush_folder_party_delete")

        const giveUp = await postReset(fastify, { quest_type: 1 })
        assert.equal(giveUp.statusCode, 200, giveUp.body)
        assert.equal(getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId, null)
        assert.deepEqual(playedKeys(), ["1:1"])
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("rush event reset route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
