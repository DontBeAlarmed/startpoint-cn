"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "small-write-routes-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const characterRoutes = require("../src/routes/api/character").default
const partyGroupRoutes = require("../src/routes/api/partyGroup").default
const profileRoutes = require("../src/routes/api/profile").default

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    db = initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `small-write-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 860000001
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })

    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(characterRoutes, { prefix: "/character" })
    await app.register(partyGroupRoutes, { prefix: "/party_group" })
    await app.register(profileRoutes, { prefix: "/profile" })
    await app.ready()

    const colorsBefore = db.prepare(`
        SELECT id, color_id FROM players_party_groups
        WHERE player_id = ? AND category = 1 AND id IN (1, 2)
        ORDER BY id
    `).all(playerId)
    db.exec(`
        CREATE TRIGGER fail_second_party_group_edit
        BEFORE UPDATE OF color_id ON players_party_groups
        WHEN OLD.player_id = ${playerId} AND OLD.category = 1 AND OLD.id = 2
        BEGIN SELECT RAISE(ABORT, 'forced party group failure'); END;
    `)
    const failedPartyEdit = await app.inject({
        method: "POST",
        url: "/party_group/edit",
        payload: {
            viewer_id: viewerId,
            party_group_edit_params_list: [
                { party_group_id: 1, party_category: 1, party_group_color_id: 1 },
                { party_group_id: 2, party_category: 1, party_group_color_id: 2 },
            ],
        },
    })
    assert.equal(failedPartyEdit.statusCode, 500)
    assert.deepEqual(db.prepare(`
        SELECT id, color_id FROM players_party_groups
        WHERE player_id = ? AND category = 1 AND id IN (1, 2)
        ORDER BY id
    `).all(playerId), colorsBefore)
    db.exec("DROP TRIGGER fail_second_party_group_edit")

    const unknownPartyGroup = await app.inject({
        method: "POST",
        url: "/party_group/edit",
        payload: {
            viewer_id: viewerId,
            party_group_edit_params_list: [
                { party_group_id: 13, party_category: 1, party_group_color_id: 3 },
            ],
        },
    })
    assert.equal(unknownPartyGroup.statusCode, 400)

    const emptyPartyCategory = await app.inject({
        method: "POST",
        url: "/party_group/edit",
        payload: {
            viewer_id: viewerId,
            party_group_edit_params_list: [
                { party_group_id: 1, party_category: 0, party_group_color_id: 3 },
            ],
        },
    })
    assert.equal(emptyPartyCategory.statusCode, 400)
    assert.equal(JSON.parse(emptyPartyCategory.body).message, "Invalid party category.")

    const settings = {
        show_opened_mana_board_second_count: true,
        show_owned_character_count: false,
        show_owned_degree_count: false,
    }
    const updateProfile = await app.inject({
        method: "POST",
        url: "/profile/update_profile_settings",
        payload: { viewer_id: viewerId, profile_settings: settings },
    })
    assert.equal(updateProfile.statusCode, 200, updateProfile.body)
    assert.deepEqual(decode(updateProfile).data.profile_settings, settings)

    updatePlayerSync({ id: playerId, degreeId: 2 })

    const readProfile = await app.inject({
        method: "POST",
        url: "/profile/get_my_profile",
        payload: { viewer_id: viewerId },
    })
    assert.equal(readProfile.statusCode, 200, readProfile.body)
    const readProfileData = decode(readProfile).data
    assert.deepEqual(readProfileData.profile_settings, settings)
    assert.equal(readProfileData.user_info.degree_id, 2, "个人资料重载必须恢复当前称号")

    const invalidProfile = await app.inject({
        method: "POST",
        url: "/profile/update_profile_settings",
        payload: {
            viewer_id: viewerId,
            profile_settings: { ...settings, show_owned_degree_count: 1 },
        },
    })
    assert.equal(invalidProfile.statusCode, 400)

    const invalidIllustration = await app.inject({
        method: "POST",
        url: "/character/set_illustration_settings",
        payload: { viewer_id: viewerId, character_id: 1, illustration_settings: "1" },
    })
    assert.equal(invalidIllustration.statusCode, 400)

    const shortIllustration = await app.inject({
        method: "POST",
        url: "/character/set_illustration_settings",
        payload: { viewer_id: viewerId, character_id: 1, illustration_settings: [1] },
    })
    assert.equal(shortIllustration.statusCode, 400)

    const unownedIllustration = await app.inject({
        method: "POST",
        url: "/character/set_illustration_settings",
        payload: { viewer_id: viewerId, character_id: 999999, illustration_settings: [1, 1, 1, 1, 1, 1] },
    })
    assert.equal(unownedIllustration.statusCode, 400)

    const validIllustration = await app.inject({
        method: "POST",
        url: "/character/set_illustration_settings",
        payload: { viewer_id: viewerId, character_id: 1, illustration_settings: [1, 1, 1, 1, 1, 1] },
    })
    assert.equal(validIllustration.statusCode, 200, validIllustration.body)
    assert.deepEqual(getPlayerCharacterSync(playerId, 1).illustrationSettings, [1, 1, 1, 1, 1, 1])

    await app.close()
    cleanup()
    process.removeListener("exit", cleanup)
}

main().then(
    () => console.log("small write route boundary tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
