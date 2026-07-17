const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
require("ts-node/register/transpile-only")

const { PartyCategory } = require("../src/data/types")
let specialEventParties = {}
let partyGroupPersistence = {}
try {
    specialEventParties = require("../src/lib/special-event-parties")
    partyGroupPersistence = require("../src/lib/party-group-persistence")
} catch {
    // The first TDD run intentionally reaches this branch before the helper exists.
}

assert.equal(PartyCategory.NORMAL, 1)
assert.equal(PartyCategory.CARNIVAL, 2)
assert.equal(PartyCategory.RAID, 3)
assert.equal(PartyCategory.RUSH, 4)

assert.equal(typeof specialEventParties.mergePartyGroupsForCategory, "function")
assert.equal(typeof specialEventParties.ensureSpecialEventPartyGroupsSync, "function")
assert.equal(typeof specialEventParties.resolvePartyGroupColorId, "function")
assert.equal(typeof specialEventParties.isPartyCategory, "function")
assert.equal(typeof specialEventParties.hasValidPartyCategory, "function")
assert.equal(typeof partyGroupPersistence.insertMissingPartyGroupListSync, "function")

assert.equal(specialEventParties.resolvePartyGroupColorId(undefined), 15)
assert.equal(specialEventParties.resolvePartyGroupColorId({ colorId: 7 }), 7)
for (const category of [1, 2, 3, 4]) {
    assert.equal(specialEventParties.isPartyCategory(category), true)
}
for (const category of [0, 5, 2.5, NaN]) {
    assert.equal(specialEventParties.isPartyCategory(category), false)
}
for (const value of [{ party_category: 1 }, { party_category: 4 }]) {
    assert.equal(specialEventParties.hasValidPartyCategory(value), true)
}
for (const value of [null, undefined, 2, {}, { party_category: "2" }, { party_category: 5 }]) {
    assert.equal(specialEventParties.hasValidPartyCategory(value), false)
}

const party = (name, category) => ({
    name,
    characterIds: [1, null, null],
    unisonCharacterIds: [null, null, null],
    equipmentIds: [null, null, null],
    abilitySoulIds: [null, null, null],
    edited: true,
    options: { allowOtherPlayersToHealMe: true },
    category,
})

const merged = specialEventParties.mergePartyGroupsForCategory(
    {
        1: {
            list: { 1: party("saved carnival", PartyCategory.CARNIVAL) },
            colorId: 2,
            category: PartyCategory.CARNIVAL,
        },
    },
    {
        1: {
            list: {
                1: party("legacy slot 1", PartyCategory.RUSH),
                2: party("legacy slot 2", PartyCategory.RUSH),
            },
            colorId: 4,
            category: PartyCategory.RUSH,
        },
        2: {
            list: { 1: party("legacy group 2", PartyCategory.RUSH) },
            colorId: 5,
            category: PartyCategory.RUSH,
        },
    },
    {
        1: {
            list: { 3: party("default slot 3", PartyCategory.CARNIVAL) },
            colorId: 15,
            category: PartyCategory.CARNIVAL,
        },
        3: {
            list: { 1: party("default group 3", PartyCategory.CARNIVAL) },
            colorId: 15,
            category: PartyCategory.CARNIVAL,
        },
    },
    PartyCategory.CARNIVAL,
)

assert.equal(merged[1].colorId, 2)
assert.equal(merged[1].list[1].name, "saved carnival")
assert.equal(merged[1].list[2].name, "legacy slot 2")
assert.equal(merged[1].list[3].name, "default slot 3")
assert.equal(merged[2].colorId, 5)
assert.equal(merged[3].colorId, 15)
for (const group of Object.values(merged)) {
    assert.equal(group.category, PartyCategory.CARNIVAL)
    for (const entry of Object.values(group.list)) {
        assert.equal(entry.category, PartyCategory.CARNIVAL)
    }
}

const reads = []
let persisted = null
const loaded = specialEventParties.ensureSpecialEventPartyGroupsSync(
    17,
    PartyCategory.CARNIVAL,
    PartyCategory.RUSH,
    {
        getGroups: (_playerId, category) => {
            reads.push(category)
            if (category === PartyCategory.CARNIVAL) {
                return persisted ?? {
                    1: {
                        list: { 1: party("saved carnival", PartyCategory.CARNIVAL) },
                        colorId: 2,
                        category: PartyCategory.CARNIVAL,
                    },
                }
            }
            return {
                1: {
                    list: { 2: party("legacy slot 2", PartyCategory.RUSH) },
                    colorId: 4,
                    category: PartyCategory.RUSH,
                },
            }
        },
        getDefaults: category => ({
            1: {
                list: { 3: party("default slot 3", category) },
                colorId: 15,
                category,
            },
        }),
        ensureGroups: (_playerId, groups) => { persisted = groups },
    },
)

assert.deepEqual(reads, [PartyCategory.CARNIVAL, PartyCategory.RUSH, PartyCategory.CARNIVAL])
assert.equal(loaded[1].list[1].name, "saved carnival")
assert.equal(loaded[1].list[2].name, "legacy slot 2")
assert.equal(loaded[1].list[3].name, "default slot 3")

const db = new Database(":memory:")
db.exec(`
    CREATE TABLE players_party_groups (
        id INTEGER NOT NULL,
        color_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (id, player_id, category)
    );
    CREATE TABLE players_parties (
        slot INTEGER NOT NULL,
        name TEXT NOT NULL,
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        unison_character_1 INTEGER,
        unison_character_2 INTEGER,
        unison_character_3 INTEGER,
        equipment_1 INTEGER,
        equipment_2 INTEGER,
        equipment_3 INTEGER,
        ability_soul_1 INTEGER,
        ability_soul_2 INTEGER,
        ability_soul_3 INTEGER,
        edited INTEGER NOT NULL,
        current_battle_power INTEGER NOT NULL DEFAULT 0,
        before_battle_power INTEGER NOT NULL DEFAULT 0,
        player_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (slot, player_id, group_id, category)
    );
`)
db.prepare("INSERT INTO players_party_groups VALUES (1, 99, 17, 2)").run()
db.prepare(`
    INSERT INTO players_parties (
        slot, name, edited, player_id, group_id, category
    ) VALUES (1, 'database winner', 1, 17, 1, 2)
`).run()

partyGroupPersistence.insertMissingPartyGroupListSync(db, 17, merged)

assert.deepEqual(
    db.prepare("SELECT id, color_id FROM players_party_groups ORDER BY id").all(),
    [{ id: 1, color_id: 99 }, { id: 2, color_id: 5 }, { id: 3, color_id: 15 }],
)
assert.deepEqual(
    db.prepare("SELECT group_id, slot, name FROM players_parties ORDER BY group_id, slot").all(),
    [
        { group_id: 1, slot: 1, name: "database winner" },
        { group_id: 1, slot: 2, name: "legacy slot 2" },
        { group_id: 1, slot: 3, name: "default slot 3" },
        { group_id: 2, slot: 1, name: "legacy group 2" },
        { group_id: 3, slot: 1, name: "default group 3" },
    ],
)
db.close()

console.log("special quest party tests passed")
