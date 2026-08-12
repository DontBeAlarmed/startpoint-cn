require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "player-history-profile-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = dataDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { setServerTime } = require("../src/utils")

initializeDatabase()
setServerTime(new Date("2025-07-25T00:00:00.000Z"))
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "player-history-profile-route",
    status: "normal",
})
const player = insertDefaultPlayerSync(account.id)
const viewerId = 760000000 + player.id
db.prepare(`
    INSERT INTO sessions (token, account_id, expires, type)
    VALUES (?, ?, ?, 2)
`).run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString())
const otherAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "player-history-profile-route-other",
    status: "normal",
})
const otherPlayer = insertDefaultPlayerSync(otherAccount.id)
const otherViewerId = 760000000 + otherPlayer.id
db.prepare(`
    INSERT INTO sessions (token, account_id, expires, type)
    VALUES (?, ?, ?, 2)
`).run(String(otherViewerId), otherAccount.id, new Date("2099-12-31T23:59:59.000Z").toISOString())

function decode(response) {
    assert.equal(response.headers["content-type"], "application/x-msgpack")
    return unpack(Buffer.from(response.body, "base64"))
}

function optionalModule(modulePath) {
    try {
        return require(modulePath)
    } catch (error) {
        if (error?.code === "MODULE_NOT_FOUND" && error.message.includes(modulePath)) return null
        throw error
    }
}

async function createApp() {
    const app = Fastify()
    registerCnMsgpackOnSend(app)

    const playerHistory = optionalModule("../src/routes/api/playerHistory")
    const social = optionalModule("../src/routes/api/socialCompatibility")
    if (playerHistory?.default) {
        await app.register(playerHistory.default, { prefix: "/api/index.php/player_history" })
    }
    if (social?.followCompatibilityRoutes) {
        await app.register(social.followCompatibilityRoutes, { prefix: "/api/index.php/follow" })
    }
    if (social?.snsCompatibilityRoutes) {
        await app.register(social.snsCompatibilityRoutes, { prefix: "/api/index.php/sns" })
    }
    await app.ready()
    return app
}

test.after(() => {
    setServerTime(null)
    if (db.open) db.close()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("player history index exposes the required client shape", async () => {
    const app = await createApp()
    try {
        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/player_history/index",
            payload: { viewer_id: viewerId, api_count: 0 },
        })
        assert.equal(response.statusCode, 200, response.body)
        const data = decode(response).data
        assert.equal(data.player_history_id, 1)
        assert.equal(data.background_card_id, 1001)
        assert.equal(data.degree_id, 1)
        assert.deepEqual(data.favorite_character, {
            character_ids: [1, null, null],
            unison_character_ids: [null, null, null],
        })
        assert.deepEqual(Object.keys(data.player_history_topic_list), Array.from(
            { length: 27 },
            (_, index) => String(index + 1),
        ))
        assert.deepEqual(data.player_history_topic_list[1], {
            is_visible: true,
            value_list: {
                int_values: null,
                string_values: null,
                date_values: [null],
                character_id_values: null,
                equipment_id_values: null,
                quest_values: null,
                boss_id_values: null,
            },
        })
        assert.deepEqual(data.player_history_topic_list[5].value_list, {
            int_values: null,
            string_values: null,
            date_values: [null],
            character_id_values: [null],
            equipment_id_values: null,
            quest_values: null,
            boss_id_values: null,
        })
        assert.deepEqual(data.player_history_topic_list[18].value_list, {
            int_values: null,
            string_values: null,
            date_values: [null],
            character_id_values: null,
            equipment_id_values: null,
            quest_values: null,
            boss_id_values: [null],
        })
        assert.deepEqual(data.player_history_topic_list[19].value_list, {
            int_values: [null, null],
            string_values: null,
            date_values: null,
            character_id_values: [null, null, null, null, null, null, null],
            equipment_id_values: null,
            quest_values: null,
            boss_id_values: null,
        })
        assert.deepEqual(data.player_history_topic_list[27].value_list, {
            int_values: [null],
            string_values: null,
            date_values: null,
            character_id_values: null,
            equipment_id_values: null,
            quest_values: null,
            boss_id_values: null,
        })
    } finally {
        await app.close()
    }
})

test("player history edit persists each supported presentation setting", async () => {
    const app = await createApp()
    try {
        const edits = [
            {
                party_info: {
                    character_ids: [1, null, null],
                    unison_character_ids: [null, 1, null],
                },
                degree_id: null,
                background_card_id: null,
                player_history_topic_visible: null,
            },
            {
                party_info: null,
                degree_id: 1,
                background_card_id: null,
                player_history_topic_visible: null,
            },
            {
                party_info: null,
                degree_id: null,
                background_card_id: 1002,
                player_history_topic_visible: null,
            },
            {
                party_info: null,
                degree_id: null,
                background_card_id: null,
                player_history_topic_visible: { "1": false },
            },
            {
                party_info: null,
                degree_id: null,
                background_card_id: null,
                player_history_topic_visible: { "2": true },
            },
        ]

        for (const body of edits) {
            const response = await app.inject({
                method: "POST",
                url: "/api/index.php/player_history/edit",
                payload: { viewer_id: viewerId, api_count: 1, ...body },
            })
            assert.equal(response.statusCode, 200, response.body)
            assert.deepEqual(decode(response).data, {})
        }

        const reloaded = decode(await app.inject({
            method: "POST",
            url: "/api/index.php/player_history/index",
            payload: { viewer_id: viewerId, api_count: 2 },
        })).data
        assert.equal(reloaded.background_card_id, 1002)
        assert.equal(reloaded.degree_id, 1)
        assert.deepEqual(reloaded.favorite_character, {
            character_ids: [1, null, null],
            unison_character_ids: [null, 1, null],
        })
        assert.equal(reloaded.player_history_topic_list[1].is_visible, false)
        assert.equal(reloaded.player_history_topic_list[2].is_visible, true)
        assert.equal(Object.keys(reloaded.player_history_topic_list).length, 27)
    } finally {
        await app.close()
    }
})

test("player history edit rejects unknown owned-state references without changing settings", async () => {
    const app = await createApp()
    try {
        const before = db.prepare(
            "SELECT * FROM players_player_history_settings WHERE player_id = ?",
        ).get(player.id)
        const invalidBodies = [
            { degree_id: 999999 },
            { background_card_id: 999999 },
            {
                party_info: {
                    character_ids: [999999, null, null],
                    unison_character_ids: [null, null, null],
                },
            },
            { player_history_topic_visible: { invalid: true } },
            { player_history_topic_visible: { "999": true } },
        ]
        for (const body of invalidBodies) {
            const response = await app.inject({
                method: "POST",
                url: "/api/index.php/player_history/edit",
                payload: { viewer_id: viewerId, ...body },
            })
            assert.equal(response.statusCode, 400, response.body)
        }
        const after = db.prepare(
            "SELECT * FROM players_player_history_settings WHERE player_id = ?",
        ).get(player.id)
        assert.deepEqual(after, before)
    } finally {
        await app.close()
    }
})

test("player history settings remain isolated by authenticated player", async () => {
    const app = await createApp()
    try {
        const edited = await app.inject({
            method: "POST",
            url: "/api/index.php/player_history/edit",
            payload: { viewer_id: viewerId, background_card_id: 1003 },
        })
        assert.equal(edited.statusCode, 200, edited.body)

        const other = decode(await app.inject({
            method: "POST",
            url: "/api/index.php/player_history/index",
            payload: { viewer_id: otherViewerId },
        })).data
        assert.equal(other.background_card_id, 1001)
        assert.equal(
            db.prepare("SELECT COUNT(*) AS count FROM players_player_history_settings WHERE player_id = ?")
                .get(otherPlayer.id).count,
            0,
        )
    } finally {
        await app.close()
    }
})

test("follow and SNS compatibility routes return explicit empty client data", async () => {
    const app = await createApp()
    try {
        const followResponse = await app.inject({
            method: "POST",
            url: "/api/index.php/follow/lists",
            payload: { viewer_id: viewerId, api_count: 0 },
        })
        assert.equal(followResponse.statusCode, 200, followResponse.body)
        assert.deepEqual(decode(followResponse).data, {
            follow_info: [],
            followed_count: 0,
        })

        const snsResponse = await app.inject({
            method: "POST",
            url: "/api/index.php/sns/get",
            payload: { viewer_id: viewerId, api_count: 1, sns_type: 0 },
        })
        assert.equal(snsResponse.statusCode, 200, snsResponse.body)
        assert.deepEqual(decode(snsResponse).data, {
            profile_image_url: null,
            twitter_id: null,
        })
    } finally {
        await app.close()
    }
})

test("CN server registers player history and social compatibility route families", () => {
    const serverSource = fs.readFileSync(path.join(__dirname, "../src/cn-server.ts"), "utf8")
    assert.match(serverSource, /playerHistoryApiPlugin/)
    assert.match(serverSource, /followCompatibilityRoutes/)
    assert.match(serverSource, /snsCompatibilityRoutes/)
    assert.match(serverSource, /\$\{apiPrefix\}\/player_history/)
    assert.match(serverSource, /\$\{apiPrefix\}\/follow/)
    assert.match(serverSource, /\$\{apiPrefix\}\/sns/)
})
