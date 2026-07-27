require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const routePath = path.resolve(__dirname, "../src/routes/api/passCard.ts")
assert.equal(fs.existsSync(routePath), true, "Pass_card 必须从固定空响应迁移为独立业务路由")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pass-card-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
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
const { getPlayerItemSync } = require("../src/data/domains/item")
const { addPlayerPassCardPointSync } = require("../src/data/domains/pass-card")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const passCardRoutes = require("../src/routes/api/passCard").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const passCardRewards = require("../assets/pass_card_reward.json")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `pass-card-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000219
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
addPlayerPassCardPointSync(playerId, 3, 100)

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(passCardRoutes)
    await fastify.ready()

    try {
        for (const [url, payload] of [
            ["/get_pass_card", undefined],
            ["/get_pass_card", null],
            ["/get_pass_card", "invalid"],
            ["/get_pass_card", []],
            ["/receive_all", undefined],
            ["/receive_all", null],
            ["/receive_all", "invalid"],
            ["/receive_all", []],
        ]) {
            const response = await fastify.inject({
                method: "POST",
                url,
                payload: payload === "invalid" ? JSON.stringify(payload) : payload,
                ...(payload === "invalid" ? { headers: { "content-type": "application/json" } } : {}),
            })
            assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}: ${response.body}`)
        }

        const getResponse = await fastify.inject({
            method: "POST",
            url: "/get_pass_card",
            payload: { viewer_id: viewerId, pass_card_id: 3 },
        })
        assert.equal(getResponse.statusCode, 200, getResponse.body)
        assert.deepEqual(unpack(Buffer.from(getResponse.body, "base64")).data, {
            point: 100,
            is_buy: false,
            all_received_record: [],
        })

        const receiveResponse = await fastify.inject({
            method: "POST",
            url: "/receive_all",
            payload: {
                viewer_id: viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [121],
                reward2_receive: [],
            },
        })
        assert.equal(receiveResponse.statusCode, 200, receiveResponse.body)
        assert.deepEqual(unpack(Buffer.from(receiveResponse.body, "base64")).data.all_received_record, [{
            reward_id: 121,
            is_received_1: 1,
            is_received_2: 0,
        }])
        assert.equal(getPlayerItemSync(playerId, 999003), 1)

        const repeatedResponse = await fastify.inject({
            method: "POST",
            url: "/receive_all",
            payload: {
                viewer_id: viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [121],
                reward2_receive: [],
            },
        })
        assert.equal(repeatedResponse.statusCode, 200, repeatedResponse.body)
        assert.equal(getPlayerItemSync(playerId, 999003), 1)

        const lockedResponse = await fastify.inject({
            method: "POST",
            url: "/receive_all",
            payload: {
                viewer_id: viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [122],
                reward2_receive: [],
            },
        })
        assert.equal(lockedResponse.statusCode, 400)
        assert.equal(getPlayerItemSync(playerId, 233), null)

        const customRewardRows = {
            122: [["3", "1", "1", "2", "880001", "", "", "", "1", "1", "999001", "", "", "", "false"]],
            123: [["3", "2", "4", "1", "", "121033", "", "", "1", "1", "999001", "", "", "", "false"]],
            124: [["3", "3", "2", "3", "", "", "5080018", "", "1", "1", "999001", "", "", "", "false"]],
            125: [["3", "4", "6", "", "", "", "", "61000", "1", "1", "999001", "", "", "", "false"]],
            126: [["3", "5", "0", "17", "", "", "", "", "1", "1", "999001", "", "", "", "false"]],
            127: [["3", "6", "3", "19", "", "", "", "", "1", "1", "999001", "", "", "", "false"]],
            128: [["3", "7", "5", "23", "", "", "", "", "1", "1", "999001", "", "", "", "false"]],
        }
        const originalRewardRows = Object.fromEntries(
            Object.keys(customRewardRows).map(rewardId => [rewardId, passCardRewards[rewardId]]),
        )
        Object.assign(passCardRewards, customRewardRows)
        db.prepare("UPDATE players_pass_cards SET point = 6000 WHERE player_id = ? AND event_id = 3")
            .run(playerId)
        const playerBeforeRollback = db.prepare(`
            SELECT free_vmoney, free_mana, exp_pool, degree_id FROM players WHERE id = ?
        `).get(playerId)
        const receivedBeforeRollback = db.prepare(`
            SELECT reward_id, is_received_1, is_received_2
            FROM players_pass_card_rewards WHERE player_id = ? AND event_id = 3 ORDER BY reward_id
        `).all(playerId)
        db.exec(`
            CREATE TRIGGER reject_second_pass_reward
            BEFORE INSERT ON players_pass_card_rewards
            WHEN NEW.player_id = ${playerId} AND NEW.reward_id = 128
            BEGIN
                SELECT RAISE(ABORT, 'injected pass reward failure');
            END
        `)
        const rollbackResponse = await fastify.inject({
            method: "POST",
            url: "/receive_all",
            payload: {
                viewer_id: viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [122, 123, 124, 125, 126, 127, 128],
                reward2_receive: [],
            },
        })
        assert.equal(rollbackResponse.statusCode, 500, rollbackResponse.body)
        db.exec("DROP TRIGGER reject_second_pass_reward")
        assert.equal(getPlayerItemSync(playerId, 880001), null)
        assert.equal(db.prepare("SELECT 1 FROM players_characters WHERE player_id = ? AND id = 121033").get(playerId), undefined)
        assert.equal(db.prepare("SELECT 1 FROM players_equipment WHERE player_id = ? AND id = 5080018").get(playerId), undefined)
        assert.equal(db.prepare("SELECT 1 FROM players_degrees WHERE player_id = ? AND degree_id = 61000").get(playerId), undefined)
        assert.deepEqual(
            db.prepare("SELECT free_vmoney, free_mana, exp_pool, degree_id FROM players WHERE id = ?").get(playerId),
            playerBeforeRollback,
        )
        assert.deepEqual(
            db.prepare(`
                SELECT reward_id, is_received_1, is_received_2
                FROM players_pass_card_rewards WHERE player_id = ? AND event_id = 3 ORDER BY reward_id
            `).all(playerId),
            receivedBeforeRollback,
        )
        Object.assign(passCardRewards, originalRewardRows)

        setServerTimeOffset(Date.parse("2024-09-01T04:00:00.000Z") - Date.now())
        const expiredResponse = await fastify.inject({
            method: "POST",
            url: "/get_pass_card",
            payload: { viewer_id: viewerId, pass_card_id: 3 },
        })
        assert.equal(expiredResponse.statusCode, 400)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("pass card route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
