"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-favorite-party-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { pack, unpack } = require("msgpackr")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertPlayerCharacterSync } = require("../src/data/domains/character")
const { updatePlayerPartySync } = require("../src/data/domains/party")
const { refreshMainPartyLeaderSync } = require("../src/lib/profile-favorite-party")
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
        idpId: `fav-party-${name}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    // viewer session（token 即 viewer_id，type 2）
    const viewerId = 700000000 + playerId
    getDb().prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    return { playerId, viewerId }
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

async function buildProfileApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded", { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(String(body), "base64"))),
    )
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    const { default: profileRoutes } = require("../src/routes/api/profile")
    await app.register(profileRoutes, { prefix: "/profile" })
    await app.ready()
    return app
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

test("leader refresh follows the favorite party, falling back to the normal first party", () => {
    const { playerId } = makePlayer("leader-refresh")
    insertPlayerCharacterSync(playerId, 111007, makeCharacter(111007, { evolutionLevel: 2 }))
    insertPlayerCharacterSync(playerId, 151006, makeCharacter(151006))
    insertPlayerCharacterSync(playerId, 111002, makeCharacter(111002))
    // 未配置喜爱配队 → 回退普通第一编队（覆盖默认种子队伍）
    updatePlayerPartySync(playerId, 1, makeParty([111007, 151006, 111002]), 1)
    updatePlayerSync({ id: playerId, partySlot: 1 })

    const fromNormal = refreshMainPartyLeaderSync(playerId, 1)
    assert.equal(fromNormal, 111007, "未配置喜爱配队时回退普通第一编队一号位")
    assert.equal(getPlayerSync(playerId).leaderCharacterId, 111007)

    // 配置喜爱配队后队长跟随喜爱配队
    updatePlayerPartySync(playerId, 1, makeParty([151006, null, null], [null, null, null], PROFILE_FAVORITE_PARTY_CATEGORY), 1)
    const fromFavorite = refreshMainPartyLeaderSync(playerId, 111007)
    assert.equal(fromFavorite, 151006, "喜爱配队一号位优先于普通编队")
    assert.equal(getPlayerSync(playerId).leaderCharacterId, 151006)

    // 喜爱配队全空成员 → 不误写，保持现队长
    updatePlayerPartySync(playerId, 1, makeParty([null, null, null], [null, null, null], PROFILE_FAVORITE_PARTY_CATEGORY), 1)
    const kept = refreshMainPartyLeaderSync(playerId, 151006)
    assert.equal(kept, 151006, "全空喜爱配队保持现队长")
    assert.equal(getPlayerSync(playerId).leaderCharacterId, 151006)
})

test("get_profile returns the favorite party when set, normal first party otherwise", async () => {
    const requester = makePlayer("card-viewer")
    // 目标 A：配置了喜爱配队（与普通编队不同）
    const withFavorite = makePlayer("card-favorite")
    insertPlayerCharacterSync(withFavorite.playerId, 111007, makeCharacter(111007, { evolutionLevel: 2 }))
    insertPlayerCharacterSync(withFavorite.playerId, 151006, makeCharacter(151006))
    insertPlayerCharacterSync(withFavorite.playerId, 111002, makeCharacter(111002, {
        exBoost: { statusId: 3, abilityIdList: [51, 52] },
    }))
    updatePlayerPartySync(withFavorite.playerId, 1, makeParty([111007, 151006, 111002]), 1)
    updatePlayerPartySync(withFavorite.playerId, 1, makeParty(
        [151006, 111002, null],
        [null, 111007, null],
        PROFILE_FAVORITE_PARTY_CATEGORY,
    ), 1)
    updatePlayerSync({ id: withFavorite.playerId, partySlot: 1 })
    // 目标 B：未配置喜爱配队 → 回退普通第一编队
    const withoutFavorite = makePlayer("card-normal")
    insertPlayerCharacterSync(withoutFavorite.playerId, 221002, makeCharacter(221002, { evolutionLevel: 1 }))
    updatePlayerPartySync(withoutFavorite.playerId, 1, makeParty([221002, 1, null]), 1)

    const app = await buildProfileApp()
    try {
        const favoriteView = decodeResponse(await app.inject({
            method: "POST",
            url: "/profile/get_profile",
            payload: { viewer_id: requester.viewerId, target_viewer_id: withFavorite.viewerId, api_count: 1 },
        })).data
        assert.deepEqual(
            favoriteView.favorite_character.character_ids,
            [151006, 111002, null],
            "资料卡展示编队 = 玩家配置的喜爱配队",
        )
        assert.deepEqual(favoriteView.favorite_character.unison_character_ids, [null, 111007, null])
        assert.deepEqual(
            favoriteView.favorite_character.character_ex_boost,
            [null, { status_id: 3, ability_id_list: [51, 52] }, null],
            "EX Boost 逐位跟随角色行",
        )
        assert.equal(
            favoriteView.target_user_info.leader_character_full_shot_evolution_level,
            0,
            "队长立绘进化等级跟随喜爱配队一号位（151006 未进化）",
        )
        assert.equal(favoriteView.target_user_info.last_login_region, "CN",
            "区域信息必填（None = 客户端 ClientError 2821）")

        const normalView = decodeResponse(await app.inject({
            method: "POST",
            url: "/profile/get_profile",
            payload: { viewer_id: requester.viewerId, target_viewer_id: withoutFavorite.viewerId, api_count: 2 },
        })).data
        assert.deepEqual(
            normalView.favorite_character.character_ids,
            [221002, 1, null],
            "未配置喜爱配队时回退普通第一编队",
        )
        assert.equal(normalView.target_user_info.leader_character_full_shot_evolution_level, 1)
    } finally {
        await app.close()
    }
})

test("get_profile unknown target answers a non-empty stub party (client renders, no F1009)", async () => {
    const requester = makePlayer("stub-viewer")
    const app = await buildProfileApp()
    try {
        const response = await app.inject({
            method: "POST",
            url: "/profile/get_profile",
            payload: { viewer_id: requester.viewerId, target_viewer_id: 999999999, api_count: 1 },
        })
        assert.equal(response.statusCode, 200, response.body)
        const favorite = decodeResponse(response).data.favorite_character
        assert.ok(favorite.character_ids.length > 0 && favorite.character_ids[0] !== null,
            "未知目标的 stub 编队首位必须有角色（空数组/空位=客户端 F1009）")
        assert.equal(favorite.character_ex_boost.length, favorite.character_ids.length)
    } finally {
        await app.close()
    }
})

test("follow projection leader follows the effective (favorite → normal) party", async () => {
    const viewer = makePlayer("follow-viewer")
    const target = makePlayer("follow-target")
    insertPlayerCharacterSync(target.playerId, 221002, makeCharacter(221002, { evolutionLevel: 1 }))
    // 角色 1 已由默认存档种下（evolution 0）；存档 leader 停在种子默认值 1
    //（历史账号形态），普通第一编队一号位是 221002，未配置喜爱配队
    updatePlayerPartySync(target.playerId, 1, makeParty([221002, 1, null]), 1)
    updatePlayerSync({ id: target.playerId, partySlot: 1, leaderCharacterId: 1 })
    getDb().prepare("INSERT INTO players_follows (follower_player_id, followed_player_id, followed_at) VALUES (?, ?, ?)")
        .run(viewer.playerId, target.playerId, 1)

    const { projectRelationFor } = require("../src/routes/api/follow/profile")
    const projected = projectRelationFor(viewer.playerId, target.playerId)
    assert.ok(projected, "关注投影应成功")
    assert.equal(projected.leader_character_id, 221002, "关注头像角色 = 有效编队一号位（而非陈旧存档值）")
    assert.equal(projected.leader_character_evolution_img_level, 1, "头像进化等级跟随该角色的真实进化")
})
