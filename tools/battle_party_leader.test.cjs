"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "battle-party-leader-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertPlayerCharacterSync } = require("../src/data/domains/character")
const { updatePlayerPartySync } = require("../src/data/domains/party")
const { resolveBattlePartyLeaderCharacterIdSync } = require("../src/lib/battle-party-leader")
const { PartyCategory, PROFILE_FAVORITE_PARTY_CATEGORY } = require("../src/data/types")

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

process.once("exit", () => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDataDirectory
})

initializeDatabase()

function makeCharacter(characterId, overrides = {}) {
    const now = new Date()
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: now,
        updateTime: now,
        exp: 0,
        stack: 0,
        manaBoardIndex: 0,
        bondTokenList: [],
        ...overrides,
    }
}

function makePlayer(name) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `battle-leader-${name}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function makeParty(characterIds, unisonCharacterIds = [null, null, null], category = PartyCategory.NORMAL) {
    return {
        name: "party",
        characterIds,
        unisonCharacterIds,
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        edited: true,
        options: { allowOtherPlayersToHealMe: false },
        category,
        currentBattlePower: 0,
        beforeBattlePower: 0,
    }
}

test("battle leader resolves from the selected party's first member (group*10+slot mapping)", () => {
    const playerId = makePlayer("resolve")
    insertPlayerCharacterSync(playerId, 111007, makeCharacter(111007, { evolutionLevel: 2 }))
    insertPlayerCharacterSync(playerId, 151006, makeCharacter(151006))
    // party id 12 = 组 2 槽 2
    updatePlayerPartySync(playerId, 2, makeParty([111007, 151006, null]), 2)

    assert.equal(
        resolveBattlePartyLeaderCharacterIdSync(playerId, 12, 1),
        111007,
        "所选编队一号位即战斗队长",
    )
})

test("battle leader is fully decoupled from the profile favorite party", () => {
    const playerId = makePlayer("decoupled")
    insertPlayerCharacterSync(playerId, 111007, makeCharacter(111007))
    insertPlayerCharacterSync(playerId, 161002, makeCharacter(161002))
    // 战斗编队一号位 111007；喜爱配队（社交层）一号位 161002
    updatePlayerPartySync(playerId, 1, makeParty([111007, null, null]), 1)
    updatePlayerPartySync(playerId, 1, makeParty([161002, null, null], [null, null, null], PROFILE_FAVORITE_PARTY_CATEGORY), 1)

    assert.equal(
        resolveBattlePartyLeaderCharacterIdSync(playerId, 1, 1),
        111007,
        "喜爱配队不得影响战斗编队队长解析",
    )
})

test("battle leader falls back: empty first slot → next member; missing row → stored → first owned → starter", () => {
    const playerId = makePlayer("fallback")
    insertPlayerCharacterSync(playerId, 151006, makeCharacter(151006))
    // 首位空位顺位取首个非空成员
    updatePlayerPartySync(playerId, 1, makeParty([null, 151006, null]), 1)
    assert.equal(resolveBattlePartyLeaderCharacterIdSync(playerId, 1, 1), 151006)

    // 非法 party id（解析失败）→ 存档 leader
    const stored = makePlayer("stored-fallback")
    insertPlayerCharacterSync(stored, 111002, makeCharacter(111002))
    updatePlayerSync({ id: stored, leaderCharacterId: 111002 })
    assert.equal(resolveBattlePartyLeaderCharacterIdSync(stored, 0, 111002), 111002)

    // 无存档 leader → 首个拥有角色（移除默认种子的角色 1，验证回退顺序）
    const ownedOnly = makePlayer("owned-fallback")
    insertPlayerCharacterSync(ownedOnly, 131001, makeCharacter(131001))
    getDb().prepare("DELETE FROM players_characters WHERE player_id = ? AND id = 1").run(ownedOnly)
    assert.equal(resolveBattlePartyLeaderCharacterIdSync(ownedOnly, 0, null), 131001)
})
