"use strict"

require("ts-node/register/transpile-only")

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
const { PartyCategory } = require("../src/data/types")

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

function makeParty(characterIds, unisonCharacterIds = [null, null, null]) {
    return {
        name: "main",
        characterIds,
        unisonCharacterIds,
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        edited: true,
        options: { allowOtherPlayersToHealMe: false },
        category: PartyCategory.NORMAL,
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

test("refreshMainPartyLeaderSync links the stored leader to the main party's first member", () => {
    const { playerId } = makePlayer("leader-refresh")
    // 三个角色，队长位角色带进化
    insertPlayerCharacterSync(playerId, 111007, makeCharacter(111007, { evolutionLevel: 2 }))
    insertPlayerCharacterSync(playerId, 151006, makeCharacter(151006))
    insertPlayerCharacterSync(playerId, 111002, makeCharacter(111002))
    // 主队伍：party id 1 = 组 1 槽 1
    updatePlayerPartySync(playerId, 1, makeParty([111007, 151006, 111002]), 1)
    updatePlayerSync({ id: playerId, partySlot: 1 })

    const nextLeader = refreshMainPartyLeaderSync(playerId, 1, getPlayerSync(playerId).leaderCharacterId)
    assert.equal(nextLeader, 111007, "队长联动到主队伍一号位")
    assert.equal(getPlayerSync(playerId).leaderCharacterId, 111007, "存档字段被写回")

    // 一号位为空时顺位取首个非空成员
    updatePlayerPartySync(playerId, 2, makeParty([null, 151006, 111002]), 1)
    const fallbackLeader = refreshMainPartyLeaderSync(playerId, 2, 111007)
    assert.equal(fallbackLeader, 151006, "一号位为空顺位取首位非空成员")

    // 全空成员的主队伍（party id 99 = 组 10 槽 9）不产生误写，保持现队长
    updatePlayerPartySync(playerId, 9, makeParty([null, null, null]), 10)
    const unchanged = refreshMainPartyLeaderSync(playerId, 99, 151006)
    assert.equal(unchanged, 151006, "全空主队伍保持现队长")
    assert.equal(getPlayerSync(playerId).leaderCharacterId, 151006)
})

test("party id mapping: main_party_id = group*10 + slot (client save layout)", () => {
    const { playerId } = makePlayer("id-mapping")
    insertPlayerCharacterSync(playerId, 241003, makeCharacter(241003))
    insertPlayerCharacterSync(playerId, 131001, makeCharacter(131001))
    updatePlayerPartySync(playerId, 3, makeParty([241003]), 1)
    updatePlayerPartySync(playerId, 2, makeParty([131001]), 2)
    updatePlayerSync({ id: playerId, partySlot: 12 })

    // party id 12 = 组 2 槽 2；party id 3 = 组 1 槽 3
    const next = refreshMainPartyLeaderSync(playerId, 12, 0)
    assert.equal(next, 131001, "party id 12 解析为组 2 槽 2")
    const next3 = refreshMainPartyLeaderSync(playerId, 3, 131001)
    assert.equal(next3, 241003, "party id 3 解析为组 1 槽 3")
})

test("get_profile returns the target's main party as favorite_character (F1009 contract)", async () => {
    const requester = makePlayer("card-viewer")
    const target = makePlayer("card-target")
    insertPlayerCharacterSync(target.playerId, 111007, makeCharacter(111007, { evolutionLevel: 2 }))
    insertPlayerCharacterSync(target.playerId, 151006, makeCharacter(151006))
    insertPlayerCharacterSync(target.playerId, 111002, makeCharacter(111002, {
        exBoost: { statusId: 3, abilityIdList: [51, 52] },
    }))
    updatePlayerPartySync(target.playerId, 1, makeParty(
        [111007, 151006, 111002],
        [null, 111002, null],
    ), 1)
    updatePlayerSync({ id: target.playerId, partySlot: 1 })

    const app = await buildProfileApp()
    try {
        const response = await app.inject({
            method: "POST",
            url: "/profile/get_profile",
            payload: { viewer_id: requester.viewerId, target_viewer_id: target.viewerId, api_count: 1 },
        })
        assert.equal(response.statusCode, 200, response.body)
        const data = decodeResponse(response).data
        const favorite = data.favorite_character
        assert.deepEqual(
            favorite.character_ids,
            [111007, 151006, 111002],
            "展示编队 = 主队伍三成员（资料页按位布局，空数组=客户端 F1009）",
        )
        assert.deepEqual(favorite.unison_character_ids, [null, 111002, null])
        assert.deepEqual(favorite.character_ex_boost, [null, null, { status_id: 3, ability_id_list: [51, 52] }],
            "EX Boost 逐位跟随角色行，无强化位为 null")
        assert.deepEqual(favorite.unison_character_ex_boost, [null, { status_id: 3, ability_id_list: [51, 52] }, null])
        assert.equal(data.target_user_info.last_login_region, "CN",
            "区域信息必填（None = 客户端 ClientError 2821）")
        assert.equal(
            data.target_user_info.leader_character_full_shot_evolution_level,
            2,
            "队长立绘进化等级跟随有效队长（主队伍一号位）",
        )
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

test("follow projection leader follows the target's main party", async () => {
    const viewer = makePlayer("follow-viewer")
    const target = makePlayer("follow-target")
    insertPlayerCharacterSync(target.playerId, 221002, makeCharacter(221002, { evolutionLevel: 1 }))
    // 角色 1 已由默认存档种下（evolution 0）；存档 leader 停在种子默认值 1
    //（历史账号形态），主队伍一号位是 221002
    updatePlayerPartySync(target.playerId, 1, makeParty([221002, 1, null]), 1)
    updatePlayerSync({ id: target.playerId, partySlot: 1, leaderCharacterId: 1 })
    getDb().prepare("INSERT INTO players_follows (follower_player_id, followed_player_id, followed_at) VALUES (?, ?, ?)")
        .run(viewer.playerId, target.playerId, 1)

    const { projectRelationFor } = require("../src/routes/api/follow/profile")
    const projected = projectRelationFor(viewer.playerId, target.playerId)
    assert.ok(projected, "关注投影应成功")
    assert.equal(projected.leader_character_id, 221002, "关注头像角色 = 主队伍一号位（而非陈旧存档值）")
    assert.equal(projected.leader_character_evolution_img_level, 1, "头像进化等级跟随该角色的真实进化")
})
