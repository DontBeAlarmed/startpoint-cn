const assert = require("node:assert/strict")
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

const unusedRouteDependencies = [
    "../src/data/activeAccount",
    "../src/data/domains/carnivalEvent",
    "../src/data/domains/character_clear",
    "../src/data/domains/degree",
    "../src/data/domains/equipment",
    "../src/data/domains/item",
    "../src/data/domains/player",
    "../src/data/domains/quest",
    "../src/data/domains/quest_active",
    "../src/data/domains/rushEvent",
    "../src/data/domains/session",
    "../src/data/types",
    "../src/lib/assets",
    "../src/lib/carnival-rewards",
    "../src/lib/character",
    "../src/lib/equipment",
    "../src/lib/mission",
    "../src/lib/quest",
    "../src/lib/quest/finish/carnival-handler",
    "../src/lib/quest/finish/challenge-point",
    "../src/lib/quest/finish/character-clear-tracker",
    "../src/lib/quest/finish/leader-powerflip-tracker",
    "../src/lib/quest/finish/party-co-clear-tracker",
    "../src/lib/quest/finish/powerflip-tracker",
    "../src/lib/quest/finish/quest-calc",
    "../src/lib/quest/finish/raid-handler",
    "../src/lib/quest/finish/rush-handler",
    "../src/lib/quest/finish/score-attack-handler",
    "../src/lib/quest/start-entry",
    "../src/lib/rush",
    "../src/lib/stamina",
    "../src/lib/stamina-cost",
    "../src/lib/types",
    "../src/routes/api/rushEvent",
    "../assets/event_challenge_point_map.json",
    "../assets/quest_entry_costs.json",
    "../assets/score_attack_border_reward.json",
]
for (const dependency of unusedRouteDependencies) stubModule(dependency, {})
stubModule("../src/utils", {
    generateDataHeaders: () => ({ servertime: "2026-07-20T00:00:00.000Z" }),
})

const abortCalls = []
stubModule("../src/data/db", {
    getDb: () => ({ transaction: operation => operation }),
})
stubModule("../src/lib/quest/active-quest-service", {
    activeQuests: {},
    persistActiveQuest() {},
    publishActiveQuest() {},
    runAbortActiveQuestTransaction(playerId, identity) {
        abortCalls.push([playerId, identity])
        return { cancelled: false, activeQuest: null, itemList: {} }
    },
})
stubModule("../src/lib/quest/finish/session-validator", {
    validateSessionAndPlayer: async () => ({ playerId: 7, playerData: {} }),
})

async function main() {
    const routes = require("../src/routes/api/singleBattleQuest").default
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    fastify.register(routes)

    const response = await fastify.inject({
        method: "POST",
        url: "/abort",
        payload: {
            viewer_id: 800000007,
            play_id: "old-play",
            quest_id: 200076009,
            category: 7,
            finish_kind: 0,
            statistics: { clear_phase: 0, party: {} },
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /^application\/x-msgpack/)
    const decoded = unpack(Buffer.from(response.body, "base64"))
    assert.deepEqual(decoded.data.item_list, {})
    assert.deepEqual(abortCalls, [[7, {
        playId: "old-play",
        questId: 200076009,
        category: 7,
    }]])
    await fastify.close()
}

main().then(
    () => console.log("quest abort route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
