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
const missionMaxWrites = []
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
    incrementPlayerCategoryMissionsIfSafeSync: (playerId, category, increments) => {
        for (const increment of increments) {
            missionWrites.push([playerId, category, increment.missionId, increment.delta])
        }
        return true
    },
    ensurePlayerCategoryMissionProgressSync: (...args) => missionMaxWrites.push(args),
})
stubModule("../src/lib/quest/finish/race-utils", {
    getCharacterRaces: characterId => ({
        1: ["Human"],
        999: ["Devil", "Beast"],
        231001: ["Dragon"],
    })[characterId] ?? [],
    getRaceKeyString: races => [...new Set(races)].sort().join("+"),
})

const { trackPartyCoClears } = require("../src/lib/quest/finish/party-co-clear-tracker")

function context(category, questId, ids, isMulti = false, statistics, unisonIds = []) {
    return {
        playerId: 17,
        questCategory: category,
        questId,
        isMulti,
        questAccomplished: true,
        clearTime: 1000,
        statistics: statistics ?? {},
        party: {
            characters: ids.map(id => ({ id })),
            unison_characters: unisonIds.map(id => ({ id })),
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

trackPartyCoClears(context(1, 1, [231001, 1], false, undefined, [999]))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 2310012, 1]])

const writesBeforeWrongRaceLeader = missionWrites.length
trackPartyCoClears(context(1, 1, [1, 231001, 999]))
assert.equal(missionWrites.length, writesBeforeWrongRaceLeader)

trackPartyCoClears(context(6, 9001, [321013]))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 3210132, 1]])

trackPartyCoClears(context(13, 2001, [321013]))
assert.deepEqual(missionWrites.slice(-2), [
    [17, 9, 3210132, 1],
    [17, 9, 3210133, 1],
])

trackPartyCoClears(context(13, 1040, [341001]))
assert.deepEqual(missionWrites.slice(-2), [
    [17, 9, 3410012, 1],
    [17, 9, 3410013, 1],
])

trackPartyCoClears(context(1, 9001, [151006, 263002]))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 1510062, 1]])

trackPartyCoClears(context(1, 1, [161002], false, { zones: [{ encoffinment_count: 0 }] }))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 1610022, 1]])

trackPartyCoClears(context(1, 1, [261007], true, {
    zones: [{ encoffinment_count: 0 }, { encoffinment_count: 0 }],
}))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 2610072, 1]])

trackPartyCoClears(context(1, 1, [1], false, {
    zones: [{ use_power_flip_count: 2 }, { use_power_flip_count: 3 }],
}))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 13, 5]])

trackPartyCoClears(context(1, 1, [121001], true, { max_combo_count: 37 }))
assert.deepEqual(missionMaxWrites.slice(-1), [[17, 9, 1210013, 37]])

trackPartyCoClears(context(1, 1, [241063, 243007, 361009]))
assert.deepEqual(missionWrites.slice(-1), [[17, 9, 2410633, 1]])

const writesBeforeFailure = missionWrites.length
const maxWritesBeforeFailure = missionMaxWrites.length
const failed = context(2, 1028004, [111001])
failed.questAccomplished = false
trackPartyCoClears(failed)
const failedRace = context(1, 1, [231001, 1], false, undefined, [999])
failedRace.questAccomplished = false
trackPartyCoClears(failedRace)
trackPartyCoClears(context(2, 1028005, [111001]))
assert.equal(missionWrites.length, writesBeforeFailure)
assert.equal(missionMaxWrites.length, maxWritesBeforeFailure)

console.log("character awake battle tracker tests passed")
