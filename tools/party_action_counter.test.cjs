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
    CREATE TABLE party_state (
        player_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        equipment_count INTEGER NOT NULL,
        unison_count INTEGER NOT NULL,
        character_count INTEGER NOT NULL,
        PRIMARY KEY (player_id, group_id, slot)
    );
`)

const players = new Map([[7, { id: 7, partySlot: 1 }]])
let failPartyWrite = false
stubModule("../src/data/db", { getDb: () => db })
stubModule("../src/data/domains/player", {
    getPlayerSync: playerId => players.get(playerId) ?? null,
    updatePlayerSync(player) {
        players.set(player.id, { ...players.get(player.id), ...player })
    },
})
stubModule("../src/data/domains/session", {
    getSession: async viewerId => viewerId === "123" ? { accountId: 9 } : null,
})
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 7 })
stubModule("../src/data/domains/character", {
    playerOwnsCharacterSync: (_playerId, characterId) => characterId !== null,
})
stubModule("../src/data/domains/equipment", {
    playerOwnsEquipmentSync: (_playerId, equipmentId) => equipmentId !== null,
})
stubModule("../src/data/domains/party", {
    updatePlayerPartySync(playerId, slot, party, groupId) {
        db.prepare(`
            INSERT INTO party_state VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(player_id, group_id, slot) DO UPDATE SET
                equipment_count = excluded.equipment_count,
                unison_count = excluded.unison_count,
                character_count = excluded.character_count
        `).run(
            playerId,
            groupId,
            slot,
            party.equipmentIds.filter(id => id !== null).length,
            party.unisonCharacterIds.filter(id => id !== null).length,
            party.characterIds.filter(id => id !== null).length,
        )
        if (failPartyWrite) throw new Error("injected party write failure")
    },
})
stubModule("../src/lib/special-event-parties", {
    hasValidPartyCategory: () => true,
    parseGlobalPartyId: partyId => ({ groupId: Math.floor(partyId / 1000), slot: partyId % 1000 }),
})
stubModule("../src/utils", {
    generateDataHeaders: values => ({ viewer_id: values.viewer_id, result_code: values.result_code ?? 1 }),
})

const {
    getActiveMissionCountersSync,
} = require("../src/data/domains/active_mission_counters")
const partyRoutes = require("../src/routes/api/party.ts").default

function partyInfo({ equipment = [], unison = [], characters = [] } = {}) {
    return {
        party_edited: true,
        party_category: 0,
        party_name: "test",
        party_id: 1001,
        unison_character_ids: unison,
        equipment_ids: equipment,
        character_ids: characters,
        ability_soul_ids: [null, null, null],
        options: { allow_other_players_to_heal_me: true },
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
    await fastify.register(partyRoutes)
    await fastify.ready()
    try {
        const response = await fastify.inject({
            method: "POST",
            url: "/edit",
            payload: {
                viewer_id: 123,
                main_party_id: 1001,
                party_info_list: [partyInfo({ equipment: [500001, null, null], unison: [200001, null, null], characters: [100001, null, null] })],
            },
        })
        assert.equal(response.statusCode, 200, response.body)
        assert.deepEqual(getActiveMissionCountersSync(7), {
            totalUsedManaCount: 0,
            totalGachaCharacterCount: 0,
            totalEquipmentEquipCount: 1,
            totalUnisonSetCount: 1,
            totalPartyCharacterSetCount: 1,
            totalInjectedExpCount: 0,
        })

        const beforeEmptyEdit = getActiveMissionCountersSync(7)
        const emptyEdit = await fastify.inject({
            method: "POST",
            url: "/edit",
            payload: {
                viewer_id: 123,
                main_party_id: 1001,
                party_info_list: [partyInfo()],
            },
        })
        assert.equal(emptyEdit.statusCode, 200)
        assert.deepEqual(getActiveMissionCountersSync(7), beforeEmptyEdit)

        const beforeFailure = getActiveMissionCountersSync(7)
        failPartyWrite = true
        const failed = await fastify.inject({
            method: "POST",
            url: "/edit",
            payload: {
                viewer_id: 123,
                main_party_id: 1001,
                party_info_list: [partyInfo({ equipment: [500002, null, null] })],
            },
        })
        failPartyWrite = false
        assert.equal(failed.statusCode, 500)
        assert.deepEqual(getActiveMissionCountersSync(7), beforeFailure)
        assert.equal(db.prepare("SELECT equipment_count FROM party_state WHERE player_id = 7").get().equipment_count, 0)
    } finally {
        await fastify.close()
        db.close()
    }
}

main().then(
    () => console.log("party action counter tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
