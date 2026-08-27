const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-election-route-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const characterElectionRoutes = require("../src/routes/api/characterElection").default

initializeDatabase()
db = getDb()

function createViewer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `character-election-${label}-${randomUUID()}`,
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    const viewerId = 710000000 + player.id
    db.prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(viewerId.toString(), account.id, new Date(Date.now() + 3600_000).toISOString())
    return { playerId: player.id, viewerId }
}

const TABLE = Object.freeze({
    "1": Object.freeze({
        stringId: "chara_election_01",
        startTime: "2022-05-02 12:00:00",
        endTime: "2022-05-13 23:59:59",
        keywordIds: Object.freeze([1000001, 1000010]),
    }),
})

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    const first = createViewer("first")
    const second = createViewer("second")
    let now = new Date("2022-05-05T04:00:00.000Z")
    const app = Fastify()
    registerCnMsgpackOnSend(app)
    await app.register(characterElectionRoutes, {
        getTable: () => TABLE,
        now: () => now,
    })
    await app.ready()

    const request = (url, body) => app.inject({ method: "POST", url, payload: body })
    try {
        const initial = decode(await request("/get_vote_status", {
            viewer_id: first.viewerId,
            api_count: 0,
            election_id: 1,
        }))
        assert.deepEqual(initial.data, { is_voted: false })

        const voted = decode(await request("/vote", {
            viewer_id: first.viewerId,
            api_count: 0,
            election_id: 1,
            keyword_id: 1000001,
        }))
        assert.equal(voted.data_headers.result_code, 1)
        assert.deepEqual(
            voted.data.mission_info.map(entry => entry.mission_id),
            [2389],
            "首次投票必须在同一次响应中完成并发放活动任务",
        )
        assert.deepEqual(
            db.prepare("SELECT election_id, keyword_id FROM players_character_election_votes WHERE player_id = ?").all(first.playerId),
            [{ election_id: 1, keyword_id: 1000001 }],
        )
        assert.equal(db.prepare(`
            SELECT progress FROM players_category_missions
            WHERE player_id = ? AND category = 3 AND id = 2389
        `).get(first.playerId).progress, 1)

        const repeated = decode(await request("/vote", {
            viewer_id: first.viewerId,
            api_count: 1,
            election_id: 1,
            keyword_id: 1000010,
        }))
        assert.equal(repeated.data_headers.result_code, 1)
        assert.deepEqual(
            db.prepare("SELECT election_id, keyword_id FROM players_character_election_votes WHERE player_id = ?").all(first.playerId),
            [{ election_id: 1, keyword_id: 1000001 }],
            "duplicate delivery must be idempotent and must not change the original vote",
        )

        const after = decode(await request("/get_vote_status", {
            viewer_id: first.viewerId,
            api_count: 2,
            election_id: 1,
        }))
        assert.deepEqual(after.data, { is_voted: true })

        const otherPlayer = decode(await request("/get_vote_status", {
            viewer_id: second.viewerId,
            api_count: 0,
            election_id: 1,
        }))
        assert.deepEqual(otherPlayer.data, { is_voted: false })

        const invalidKeyword = await request("/vote", {
            viewer_id: second.viewerId,
            api_count: 1,
            election_id: 1,
            keyword_id: 9999999,
        })
        assert.equal(invalidKeyword.statusCode, 400)
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_character_election_votes WHERE player_id = ?").get(second.playerId).count, 0)

        now = new Date("2022-05-14T00:00:00.000Z")
        const expired = decode(await request("/vote", {
            viewer_id: second.viewerId,
            api_count: 2,
            election_id: 1,
            keyword_id: 1000001,
        }))
        assert.equal(expired.data_headers.result_code, 11003)
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_character_election_votes WHERE player_id = ?").get(second.playerId).count, 0)

        now = new Date("2022-05-05T04:00:00.000Z")
        db.prepare(`
            INSERT INTO players_category_missions (category, id, progress, player_id)
            VALUES (3, 2389, -1, ?)
        `).run(second.playerId)
        const corruptedProgress = await request("/vote", {
            viewer_id: second.viewerId,
            api_count: 3,
            election_id: 1,
            keyword_id: 1000010,
        })
        assert.equal(corruptedProgress.statusCode, 500)
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_character_election_votes WHERE player_id = ?").get(second.playerId).count, 0)
        db.prepare(`
            DELETE FROM players_category_missions
            WHERE player_id = ? AND category = 3 AND id = 2389
        `).run(second.playerId)

        db.exec(`
            CREATE TRIGGER fail_character_election_mission
            BEFORE INSERT ON players_category_missions
            WHEN NEW.player_id = ${second.playerId} AND NEW.category = 3 AND NEW.id = 2389
            BEGIN
                SELECT RAISE(FAIL, 'forced election mission failure');
            END
        `)
        const failed = await request("/vote", {
            viewer_id: second.viewerId,
            api_count: 4,
            election_id: 1,
            keyword_id: 1000010,
        })
        assert.equal(failed.statusCode, 500)
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_character_election_votes WHERE player_id = ?").get(second.playerId).count, 0)
    } finally {
        await app.close()
    }
}

test("character election routes persist vote status and mission fact atomically", { timeout: 60_000 }, main)
