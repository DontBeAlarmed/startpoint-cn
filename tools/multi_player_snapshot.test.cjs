const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getPlayerCharactersByIdsSync,
    getPlayerCharactersManaNodeAwakeLevelsByIdsSync,
} = require("../src/data/domains/character")
const { getPlayerEquipmentsByIdsSync } = require("../src/data/domains/equipment")
const { getPlayerPartyGroupListsSync } = require("../src/data/domains/party")
const { PartyCategory } = require("../src/data/types")
const { buildPlayerSnapshot } = require("../src/multi/snapshot/player-snapshot")

function party(name, characterId, unisonId, equipmentId, soulId) {
    return {
        name,
        characterIds: [characterId, null, null],
        unisonCharacterIds: [unisonId, null, null],
        equipmentIds: [equipmentId, null, null],
        abilitySoulIds: [soulId, null, null],
        edited: true,
        options: { allowOtherPlayersToHealMe: true },
        category: PartyCategory.NORMAL,
    }
}

function fixture() {
    const currentParty = party("Current", 101001, 101002, 501001, 601001)
    const npcOne = party("NPC Alpha", 102001, null, null, null)
    const npcTwo = party("NPC Beta", 103001, null, null, null)
    const npcThree = party("NPC Ignored", 104001, null, null, null)
    npcTwo.category = PartyCategory.EVENT
    npcThree.category = PartyCategory.EVENT

    const characters = new Map([
        [101001, {
            evolutionLevel: 2,
            exp: 345,
            overLimitStep: 1,
            exBoost: { statusId: 7, abilityIdList: [11, 12] },
        }],
        [101002, { evolutionLevel: 3, exp: 456, overLimitStep: 2 }],
        [102001, { evolutionLevel: 1, exp: 10, overLimitStep: 0 }],
        [103001, { evolutionLevel: 4, exp: 20, overLimitStep: 3 }],
        [104001, { evolutionLevel: 5, exp: 30, overLimitStep: 4 }],
    ])
    const equipment = { level: 4, enhancementLevel: 2 }
    const normalGroups = {
        1: { list: { 1: npcOne }, category: PartyCategory.NORMAL },
        2: { list: { 2: currentParty }, category: PartyCategory.NORMAL },
    }
    const eventGroups = {
        1: { list: { 1: npcTwo, 2: npcThree }, category: PartyCategory.EVENT },
    }
    const player = {
        id: 77,
        name: "Host",
        rankPoint: 9_999,
        degreeId: 8,
        leaderCharacterId: 101001,
        role: 2,
        tutorialStep: 0,
        partySlot: 1,
        vmoney: 999,
        freeMana: 888,
        deviceId: "must-not-leak",
    }
    const dependencies = {
        resolvePlayerContext: async viewerId => viewerId === 101 ? { playerId: 77, player } : null,
        getPartyGroups: (_playerId, category) => category === PartyCategory.NORMAL
            ? normalGroups
            : eventGroups,
        getCharacter: (_playerId, characterId) => characters.get(characterId) ?? null,
        getManaNodeAwakeLevels: (_playerId, characterId) => characterId === 101001
            ? { 301: 0, 302: 2 }
            : {},
        getEquipment: (_playerId, equipmentId) => equipmentId === 501001 ? equipment : null,
        getRankLevel: () => 42,
    }
    return { characters, currentParty, dependencies, equipment, player }
}

test("builds the minimal current-player snapshot and at most two NPC parties", async () => {
    const { dependencies } = fixture()
    const snapshot = await buildPlayerSnapshot(101, 12, dependencies)

    assert.deepEqual(Object.keys(snapshot).sort(), [
        "currentPartyId",
        "degreeId",
        "isNewbie",
        "mainCharacterId",
        "name",
        "npcParties",
        "party",
        "playerRoleKind",
        "rank",
        "viewerId",
    ])
    assert.deepEqual({
        viewerId: snapshot.viewerId,
        name: snapshot.name,
        rank: snapshot.rank,
        degreeId: snapshot.degreeId,
        mainCharacterId: snapshot.mainCharacterId,
        playerRoleKind: snapshot.playerRoleKind,
        isNewbie: snapshot.isNewbie,
        currentPartyId: snapshot.currentPartyId,
    }, {
        viewerId: 101,
        name: "Host",
        rank: 42,
        degreeId: 8,
        mainCharacterId: 101001,
        playerRoleKind: 2,
        isNewbie: false,
        currentPartyId: 12,
    })
    assert.deepEqual(snapshot.party.characters[0], [0, {
        id: 101001,
        evolution_level: 2,
        exp: 345,
        over_limit_step: 1,
        mana_node_ids: { 301: 0, 302: 2 },
        ex_boost: [0, { ability_id_list: [11, 12], status_id: 7 }],
        illustration_settings: [1],
    }])
    assert.deepEqual(snapshot.party.unison_characters[0][1].id, 101002)
    assert.deepEqual(snapshot.party.equipments[0], [0, {
        equipmentId: 501001,
        level: 4,
        enhancementLevel: 2,
    }])
    assert.deepEqual(snapshot.party.abilitySoulIds, [[0, 601001], [1], [1]])
    assert.equal(snapshot.npcParties.length, 2)
    assert.deepEqual(snapshot.npcParties.map(value => value.characters[0][1].id), [102001, 103001])
    assert.equal(JSON.stringify(snapshot).includes("playerId"), false)
    assert.equal(JSON.stringify(snapshot).includes("vmoney"), false)
    assert.equal(JSON.stringify(snapshot).includes("device"), false)
})

test("snapshot data is deeply isolated from mutable database objects", async () => {
    const { characters, currentParty, dependencies, equipment } = fixture()
    const snapshot = await buildPlayerSnapshot(101, 12, dependencies)

    currentParty.characterIds[0] = 999999
    characters.get(101001).exBoost.abilityIdList[0] = 99
    equipment.level = 99

    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.party.characters[0][1].ex_boost[1].ability_id_list), true)
    assert.equal(snapshot.party.characters[0][1].id, 101001)
    assert.deepEqual(snapshot.party.characters[0][1].ex_boost[1].ability_id_list, [11, 12])
    assert.equal(snapshot.party.equipments[0][1].level, 4)
})

test("missing current party assets use Option.None without inventing values", async () => {
    const { dependencies } = fixture()
    dependencies.getCharacter = () => null
    dependencies.getEquipment = () => null

    const snapshot = await buildPlayerSnapshot(101, 12, dependencies)

    assert.deepEqual(snapshot.party.characters, [[1], [1], [1]])
    assert.deepEqual(snapshot.party.unison_characters, [[1], [1], [1]])
    assert.deepEqual(snapshot.party.equipments, [[1], [1], [1]])
    assert.deepEqual(snapshot.party.abilitySoulIds, [[0, 601001], [1], [1]])
})

test("deduplicates repeated character, mana-node, and equipment reads across NPC parties", async () => {
    const { dependencies } = fixture()
    const sharedCurrent = party("Current", 101001, 101002, 501001, 601001)
    const sharedNpc = party("NPC Alpha", 101001, 101002, 501001, 601001)
    const sharedEventNpc = party("NPC Beta", 101001, 101002, 501001, 601001)
    sharedEventNpc.category = PartyCategory.EVENT
    dependencies.getPartyGroups = (_playerId, category) => category === PartyCategory.NORMAL
        ? { 1: { category, colorId: 1, list: { 1: sharedCurrent, 2: sharedNpc } } }
        : { 1: { category, colorId: 2, list: { 1: sharedEventNpc } } }

    const calls = { character: 0, equipment: 0, manaNode: 0 }
    for (const [name, field] of [
        ["getCharacter", "character"],
        ["getEquipment", "equipment"],
        ["getManaNodeAwakeLevels", "manaNode"],
    ]) {
        const original = dependencies[name]
        dependencies[name] = (...args) => {
            calls[field]++
            return original(...args)
        }
    }

    const snapshot = await buildPlayerSnapshot(101, 1, dependencies)

    assert.deepEqual(calls, { character: 2, equipment: 1, manaNode: 2 })
    assert.deepEqual(snapshot.party.characters[0][1].id, 101001)
    assert.deepEqual(snapshot.npcParties.map(value => value.characters[0][1].id), [101001, 101001])
})

test("returns null when the viewer has no local player context", async () => {
    const { dependencies } = fixture()
    dependencies.resolvePlayerContext = async () => null

    assert.equal(await buildPlayerSnapshot(101, 12, dependencies), null)
})

test("empty batch snapshot reads do not require a database", () => {
    assert.deepEqual(getPlayerCharactersByIdsSync(77, []), {})
    assert.deepEqual(getPlayerCharactersManaNodeAwakeLevelsByIdsSync(77, []), {})
    assert.deepEqual(getPlayerEquipmentsByIdsSync(77, []), {})
    assert.deepEqual(getPlayerPartyGroupListsSync(77, []), {})
})
