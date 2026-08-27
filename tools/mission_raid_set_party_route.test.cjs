const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

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
        total_injected_exp_count INTEGER NOT NULL DEFAULT 0,
        total_gacha_campaign_count INTEGER NOT NULL DEFAULT 0,
        practice_quest_challenge_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE players_category_missions (
        category INTEGER NOT NULL,
        id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (category, id, player_id)
    );
    CREATE TABLE party_state (
        player_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        category INTEGER NOT NULL,
        equipment_count INTEGER NOT NULL,
        PRIMARY KEY (player_id, group_id, slot, category)
    );
`)

const players = new Map([[7, { id: 7, partySlot: 1 }]])
let evaluationTime = new Date("2024-05-23T04:00:00.000Z")

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
    getPlayerEquipmentListSync: () => ({
        "500001": { stack: 0 },
        "500002": { stack: 0 },
        "500010": { stack: 0 },
        "500011": { stack: 0 },
    }),
})
stubModule("../src/data/domains/item", { getPlayerItemsSync: () => ({}) })
stubModule("../src/data/domains/party", {
    getPlayerPartyLoadoutSync: () => null,
    updatePlayerPartySync(playerId, slot, party, groupId) {
        db.prepare(`
            INSERT INTO party_state VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(player_id, group_id, slot, category) DO UPDATE SET
                equipment_count = excluded.equipment_count
        `).run(
            playerId,
            groupId,
            slot,
            party.category,
            party.equipmentIds.filter(id => id !== null).length,
        )
    },
})
stubModule("../src/lib/mail-notification", { getMailArrivedSync: () => 0 })
stubModule("../src/utils", {
    generateDataHeaders: values => ({ viewer_id: values.viewer_id, result_code: values.result_code ?? 1 }),
    getServerTime: () => evaluationTime.getTime() / 1000,
})
const missionSettlementCalls = []
stubModule("../src/lib/mission/settlement", {
    settleMissionCategories: (...args) => {
        missionSettlementCalls.push(args)
        return {
            missionInfo: [400054, 400055, 400056].map(missionId => ({
                mission_category_id: 3,
                mission_id: missionId,
                mission_reward_id: missionId * 10 + 1,
            })),
            itemList: {},
            characterList: [],
            equipmentList: [],
            degreeIds: [],
            passCardPoints: {},
        }
    },
})

const { PartyCategory } = require("../src/data/types")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const partyRoutes = require("../src/routes/api/party.ts").default

function partyInfo({
    partyId,
    category = PartyCategory.RAID,
    equipment = [500001, null, null],
} = {}) {
    return {
        party_edited: true,
        party_category: category,
        party_name: `party-${partyId}`,
        party_id: partyId,
        unison_character_ids: [200001, null, null],
        equipment_ids: equipment,
        character_ids: [100001, null, null],
        ability_soul_ids: [null, null, null],
        options: { allow_other_players_to_heal_me: true },
    }
}

function missionProgress(missionId) {
    return db.prepare(`
        SELECT progress FROM players_category_missions
        WHERE player_id = 7 AND category = 3 AND id = ?
    `).get(missionId)?.progress
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

    const edit = (partyInfoList, usePartyGroupEdit = true) => fastify.inject({
        method: "POST",
        url: "/edit",
        payload: {
            viewer_id: 123,
            use_party_group_edit: usePartyGroupEdit,
            main_party_id: 1,
            party_info_list: partyInfoList,
        },
    })

    try {
        const threeSlots = await edit([
            partyInfo({ partyId: 1 }),
            partyInfo({ partyId: 2 }),
            partyInfo({ partyId: 2, equipment: [500002, null, null] }),
            partyInfo({ partyId: 3 }),
        ])
        assert.equal(threeSlots.statusCode, 200, threeSlots.body)
        assert.deepEqual(
            [400054, 400055, 400056].map(missionProgress),
            [1, 1, 1],
            "SET 编辑器成功保存主/副1/副2槽后应各完成一条事实",
        )
        const responseData = unpack(threeSlots.rawPayload)
        assert.deepEqual(
            responseData.data.mission_info.map(entry => entry.mission_id),
            [400054, 400055, 400056],
            "Raid SET 保存必须在同一次响应中返回活动任务结算",
        )
        assert.equal(missionSettlementCalls.length, 1)

        evaluationTime = new Date("2024-12-05T04:00:00.000Z")
        const ordinaryEdit = await edit([partyInfo({ partyId: 1 })], false)
        assert.equal(ordinaryEdit.statusCode, 200)
        const nonRaid = await edit([partyInfo({ partyId: 1, category: PartyCategory.NORMAL })])
        assert.equal(nonRaid.statusCode, 200)
        const wrongGroupAndSlot = await edit([
            partyInfo({ partyId: 11 }),
            partyInfo({ partyId: 4 }),
        ])
        assert.equal(wrongGroupAndSlot.statusCode, 200)
        assert.deepEqual([400072, 400073, 400074].map(missionProgress), [undefined, undefined, undefined])

        const beforeFailureCounters = getActiveMissionCountersSync(7)
        const beforeFailureParty = db.prepare(`
            SELECT equipment_count FROM party_state
            WHERE player_id = 7 AND group_id = 1 AND slot = 1 AND category = ?
        `).get(PartyCategory.RAID).equipment_count
        db.exec(`
            CREATE TRIGGER fail_raid_set_mission
            BEFORE INSERT ON players_category_missions
            WHEN NEW.player_id = 7 AND NEW.category = 3 AND NEW.id = 400073
            BEGIN
                SELECT RAISE(FAIL, 'forced RAID SET mission failure');
            END
        `)
        const failed = await edit([
            partyInfo({ partyId: 1, equipment: [500010, 500011, null] }),
            partyInfo({ partyId: 2 }),
        ])
        assert.equal(failed.statusCode, 500)
        assert.match(failed.body, /forced RAID SET mission failure/)
        assert.deepEqual(getActiveMissionCountersSync(7), beforeFailureCounters)
        assert.equal(db.prepare(`
            SELECT equipment_count FROM party_state
            WHERE player_id = 7 AND group_id = 1 AND slot = 1 AND category = ?
        `).get(PartyCategory.RAID).equipment_count, beforeFailureParty)
        assert.deepEqual([400072, 400073, 400074].map(missionProgress), [undefined, undefined, undefined])
    } finally {
        await fastify.close()
        db.close()
    }
}

main().then(
    () => console.log("mission RAID SET party route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
