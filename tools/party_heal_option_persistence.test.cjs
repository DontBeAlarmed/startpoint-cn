"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "party-heal-option-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType, PartyCategory } = require("../src/data/types")
const { getPlayerPartyGroupListSync } = require("../src/data/domains/party")
const { exportPlayerSaveV2Sync, restorePlayerSaveV2Sync } = require("../src/data/player-save")
const { serializePartyGroupList } = require("../src/data/utils/serialize-entities")
const partyRoutes = require("../src/routes/api/party").default
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

let app
let restoreContentSnapshot

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    return insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    }).then(() => ({ playerId, viewerId }))
}

let nextViewerId = 930000000

function editPayload(viewerId, allowHeal) {
    return {
        use_party_group_edit: false,
        main_party_id: 1,
        viewer_id: viewerId,
        ignore_ngword: false,
        api_count: 1,
        party_info_list: [{
            party_edited: true,
            party_category: PartyCategory.NORMAL,
            party_name: "Party A",
            party_id: 1,
            unison_character_ids: [null, null, null],
            equipment_ids: [null, null, null],
            character_ids: [1, null, null],
            ability_soul_ids: [null, null, null],
            options: { allow_other_players_to_heal_me: allowHeal },
        }],
    }
}

function firstPartyOptions(playerId) {
    const groups = getPlayerPartyGroupListSync(playerId)
    return groups["1"].list["1"].options
}

function serializedOption(playerId) {
    const groups = getPlayerPartyGroupListSync(playerId)
    return serializePartyGroupList(groups)["1"].list[1].options.allow_other_players_to_heal_me
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
    app.register(partyRoutes, { prefix: "/api/index.php/party" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("fresh players default the heal option to true", async () => {
    const { playerId } = await createPlayer("default-true")
    assert.deepEqual(firstPartyOptions(playerId), { allowOtherPlayersToHealMe: true })
    assert.equal(serializedOption(playerId), true)
})

test("party edit persists allow_other_players_to_heal_me", async t => {
    const { playerId, viewerId } = await createPlayer("edit-false")
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/party/edit",
        payload: editPayload(viewerId, false),
    })
    assert.equal(response.statusCode, 200, response.body)

    assert.deepEqual(firstPartyOptions(playerId), { allowOtherPlayersToHealMe: false })
    assert.equal(serializedOption(playerId), false)
    const row = getDb().prepare(`
        SELECT allow_other_players_to_heal_me FROM players_parties
        WHERE player_id = ? AND group_id = 1 AND slot = 1 AND category = ?
    `).get(playerId, PartyCategory.NORMAL)
    assert.equal(row.allow_other_players_to_heal_me, 0)

    // Toggling back to true persists as well.
    const back = await app.inject({
        method: "POST",
        url: "/api/index.php/party/edit",
        payload: editPayload(viewerId, true),
    })
    assert.equal(back.statusCode, 200, back.body)
    assert.deepEqual(firstPartyOptions(playerId), { allowOtherPlayersToHealMe: true })
    t.after(() => undefined)
})

test("v2 export and restore preserve the heal option", async () => {
    const source = await createPlayer("export-source")
    const edit = await app.inject({
        method: "POST",
        url: "/api/index.php/party/edit",
        payload: editPayload(source.viewerId, false),
    })
    assert.equal(edit.statusCode, 200, edit.body)

    const snapshot = exportPlayerSaveV2Sync(source.playerId)
    const partyRow = Object.values(snapshot.domains)
        .flatMap(domain => Object.entries(domain.tables))
        .find(([table]) => table === "players_parties")[1]
        .find(row => row.group_id === 1 && row.slot === 1 && row.category === PartyCategory.NORMAL)
    assert.equal(partyRow.allow_other_players_to_heal_me, 0)

    const target = await createPlayer("restore-target")
    restorePlayerSaveV2Sync(snapshot, target.playerId)
    assert.deepEqual(firstPartyOptions(target.playerId), { allowOtherPlayersToHealMe: false })
    assert.equal(serializedOption(target.playerId), false)
})
