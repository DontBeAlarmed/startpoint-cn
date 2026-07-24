const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const Fastify = require("fastify")
const { pack } = require("msgpackr")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const db = new Database(":memory:")
db.exec(`
    CREATE TABLE players_active_mission_counters (
        player_id INTEGER PRIMARY KEY,
        total_used_mana_count INTEGER NOT NULL DEFAULT 0,
        total_gacha_character_count INTEGER NOT NULL DEFAULT 0,
        total_equipment_equip_count INTEGER NOT NULL DEFAULT 0,
        total_unison_set_count INTEGER NOT NULL DEFAULT 0,
        total_party_character_set_count INTEGER NOT NULL DEFAULT 0,
        total_injected_exp_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE player_state (
        id INTEGER PRIMARY KEY,
        exp_pool INTEGER NOT NULL
    );
    CREATE TABLE character_state (
        player_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        exp INTEGER NOT NULL,
        PRIMARY KEY (player_id, character_id)
    );
    INSERT INTO player_state VALUES (7, 2000);
    INSERT INTO character_state VALUES (7, 100001, 0);
`)

let failExpWrite = false
stubModule("../src/data/db", { getDb: () => db })
stubModule("../src/data/domains/account", { getAccountPlayers: () => [] })
stubModule("../src/data/domains/session", {
    getSession: async viewerId => viewerId === "123" ? { accountId: 9 } : null,
})
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 7 })
stubModule("../src/data/domains/player", {
    getPlayerSync(playerId) {
        const row = db.prepare("SELECT * FROM player_state WHERE id = ?").get(playerId)
        return row === undefined ? null : {
            id: row.id,
            expPool: row.exp_pool,
            expPooledTime: new Date("2026-01-01T00:00:00.000Z"),
        }
    },
    updatePlayerSync(player) {
        const current = db.prepare("SELECT * FROM player_state WHERE id = ?").get(player.id)
        db.prepare("UPDATE player_state SET exp_pool = ? WHERE id = ?")
            .run(player.expPool ?? current.exp_pool, player.id)
    },
})
stubModule("../src/data/domains/character", {
    getPlayerCharacterSync(playerId, characterId) {
        const row = db.prepare(
            "SELECT * FROM character_state WHERE player_id = ? AND character_id = ?",
        ).get(playerId, characterId)
        return row === undefined ? null : { id: row.character_id, exp: row.exp }
    },
    getPlayerCharactersSync: () => ({}),
    updatePlayerCharacterSync() {},
})
stubModule("../src/data/domains/item", {
    getPlayerItemsSync: () => ({}),
    givePlayerItemSync: () => 0,
})
stubModule("../src/routes/api/character", { characterMaxOverLimits: () => 0 })
stubModule("../src/lib/assets", { getCharacterDataSync: () => null })
stubModule("../src/data/utils", { clientSerializeDate: value => value })
stubModule("../src/lib/character-stack", { validateCharacterStackConversion: () => null })
stubModule("../src/utils", {
    generateDataHeaders: values => ({ viewer_id: values.viewer_id, result_code: values.result_code ?? 1 }),
    getServerTime: () => 0,
})
stubModule("../src/lib/character", {
    givePlayerCharactersExpSync(playerId, characterIds, amount) {
        const characterId = characterIds[0]
        db.prepare("UPDATE character_state SET exp = exp + ? WHERE player_id = ? AND character_id = ?")
            .run(amount, playerId, characterId)
        if (failExpWrite) throw new Error("injected character exp failure")
        const expPool = db.prepare("SELECT exp_pool FROM player_state WHERE id = ?").get(playerId).exp_pool
        return {
            add_exp_list: [{ character_id: characterId, exp: amount }],
            character_list: [],
            exp_pool: expPool,
        }
    },
})

const counterDomain = require("../src/data/domains/active_mission_counters")
const expodRoutes = require("../src/routes/api/expod.ts").default

function state() {
    return {
        expPool: db.prepare("SELECT exp_pool FROM player_state WHERE id = 7").get().exp_pool,
        characterExp: db.prepare("SELECT exp FROM character_state WHERE player_id = 7 AND character_id = 100001").get().exp,
        counters: counterDomain.getActiveMissionCountersSync(7),
    }
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
    await fastify.register(expodRoutes)
    await fastify.ready()
    try {
        const success = await fastify.inject({
            method: "POST",
            url: "/inject_exp",
            payload: { viewer_id: 123, character_id: 100001, exp: 1000 },
        })
        assert.equal(success.statusCode, 200, success.body)
        assert.equal(state().expPool, 1000)
        assert.equal(state().characterExp, 1000)
        assert.equal(state().counters.totalInjectedExpCount, 1)

        const beforeFailure = state()
        failExpWrite = true
        const failed = await fastify.inject({
            method: "POST",
            url: "/inject_exp",
            payload: { viewer_id: 123, character_id: 100001, exp: 500 },
        })
        failExpWrite = false
        assert.equal(failed.statusCode, 500)
        assert.deepEqual(state(), beforeFailure, "角色经验写入失败必须回滚经验池和 Active Mission 计数")
    } finally {
        await fastify.close()
        db.close()
    }
}

main().then(
    () => console.log("expod inject exp route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
