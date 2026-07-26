require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raid-event-summary-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    incrementPlayerRaidEventQuestKillCountSync,
    upsertRaidEventBossStateSync,
} = require("../src/data/domains/raidEvent")
const raidEventRoutes = require("../src/routes/api/raidEvent").default

async function main() {
    initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "raid-event-summary-route",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const initialMana = getPlayerSync(playerId).freeMana
    getDb().prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run("123", account.id, "2999-01-01T00:00:00.000Z", 2)
    upsertRaidEventBossStateSync(4, { weightedKillCount: 0, totalKillCount: 1 })
    incrementPlayerRaidEventQuestKillCountSync(playerId, 4, 4001)

    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(raidEventRoutes)
    await fastify.ready()
    try {
        const firstResponse = await fastify.inject({
            method: "POST",
            url: "/summary",
            payload: { viewer_id: 123, event_id: 4, api_count: 1 },
        })
        assert.equal(firstResponse.statusCode, 200, firstResponse.body)
        const first = unpack(firstResponse.rawPayload).data
        assert.equal(first.kill_count_reward_data.received_up_to, 1)
        assert.deepEqual(first.quest_list, { 4001: { kill_count: 1 } })
        assert.equal(first.kill_count_reward_data.reward_list.length, 2)
        assert.equal(first.user_info.free_mana, initialMana + 500)
        assert.deepEqual(first.item_list, { 100000: 25 })
        assert.equal("items" in first, false)
        assert.equal(getPlayerSync(playerId).freeMana, initialMana + 500)
        assert.equal(getPlayerItemSync(playerId, 100000), 25)

        const secondResponse = await fastify.inject({
            method: "POST",
            url: "/summary",
            payload: { viewer_id: 123, event_id: 4, api_count: 2 },
        })
        assert.equal(secondResponse.statusCode, 200, secondResponse.body)
        const second = unpack(secondResponse.rawPayload).data
        assert.deepEqual(second.kill_count_reward_data.reward_list, [])
        assert.equal(getPlayerSync(playerId).freeMana, initialMana + 500)
        assert.equal(getPlayerItemSync(playerId, 100000), 25)

        upsertRaidEventBossStateSync(4, { weightedKillCount: 0, totalKillCount: 2 })
        getDb().exec(`
            CREATE TRIGGER fail_raid_reward_cursor
            BEFORE UPDATE ON players_raid_events
            BEGIN
                SELECT RAISE(FAIL, 'injected raid reward cursor failure');
            END;
        `)
        const failedResponse = await fastify.inject({
            method: "POST",
            url: "/summary",
            payload: { viewer_id: 123, event_id: 4, api_count: 3 },
        })
        assert.equal(failedResponse.statusCode, 500)
        getDb().exec("DROP TRIGGER fail_raid_reward_cursor")
        assert.equal(getPlayerSync(playerId).freeMana, initialMana + 500)
        assert.equal(getPlayerItemSync(playerId, 100000), 25)
        assert.equal(
            getDb().prepare("SELECT received_up_to FROM players_raid_events WHERE player_id = ? AND event_id = 4")
                .get(playerId).received_up_to,
            1,
        )

        upsertRaidEventBossStateSync(999, { weightedKillCount: 0, totalKillCount: 1 })
        const invalidEventResponse = await fastify.inject({
            method: "POST",
            url: "/summary",
            payload: { viewer_id: 123, event_id: 999, api_count: 4 },
        })
        assert.equal(invalidEventResponse.statusCode, 400)
        assert.equal(
            getDb().prepare("SELECT COUNT(*) AS count FROM players_raid_events WHERE player_id = ? AND event_id = 999")
                .get(playerId).count,
            0,
            "无效主数据必须在写入领奖游标前拒绝",
        )
    } finally {
        await fastify.close()
    }
}

main().then(
    () => console.log("raid event summary route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
).finally(() => {
    closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
