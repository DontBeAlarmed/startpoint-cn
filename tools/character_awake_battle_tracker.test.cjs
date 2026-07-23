require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const pairWrites = []
const missionWrites = []
stubModule("../src/data/db", {
    getDb: () => ({
        prepare(sql) {
            if (sql.includes("players_party_member_co_clears")) {
                return { run: (...args) => pairWrites.push(args) }
            }
            return { run: () => {} }
        },
        transaction: operation => operation,
    }),
})
stubModule("../src/data/domains/mission", {
    incrementPlayerCategoryMissionSync: (...args) => missionWrites.push(args),
})
stubModule("../src/lib/quest/finish/race-utils", {
    getCharacterRaces: characterId => ({
        1: ["Human"],
        999: ["Devil"],
        231001: ["Dragon"],
    })[characterId] ?? [],
    getRaceKeyString: races => [...new Set(races)].sort().join("+"),
})

const { trackPartyCoClears } = require("../src/lib/quest/finish/party-co-clear-tracker")

function context(category, questId, ids, isMulti = false) {
    return {
        playerId: 17,
        questCategory: category,
        questId,
        isMulti,
        party: {
            characters: ids.map(id => ({ id })),
            unison_characters: [],
        },
    }
}

trackPartyCoClears(context(15, 5, [331003, 1]))
assert.deepEqual(pairWrites, [[17, 1, 331003]])
assert.deepEqual(missionWrites, [[17, 9, 3310032, 1]])

trackPartyCoClears(context(15, 6, [1, 331003]))
assert.deepEqual(missionWrites, [[17, 9, 3310032, 1]])

trackPartyCoClears(context(2, 1010004, [331003, 10], true))
assert.deepEqual(missionWrites, [[17, 9, 3310032, 1]])

trackPartyCoClears(context(1, 1, [231001, 1, 999]))
assert.deepEqual(missionWrites, [
    [17, 9, 3310032, 1],
    [17, 9, 2310012, 1],
])

trackPartyCoClears(context(1, 1, [1, 231001, 999]))
assert.deepEqual(missionWrites, [
    [17, 9, 3310032, 1],
    [17, 9, 2310012, 1],
])

console.log("character awake battle tracker tests passed")
