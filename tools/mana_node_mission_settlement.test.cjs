// 玛纳板节点强化(learn_mana_node)的任务结算回归:
// 「玛纳板累计强化数」(mission 37, total_released_mana_node_count,阶段
// 目标 1/5/15/30/50/70/100/200,每档 30 星导石)与「第二枚玛纳板全部强化
// 完成」(mission 96, manaboard_2nd_complete_count,阶段目标 1/2/3/...,每档
// 50 星导石)是状态派生任务(从已学节点集合现算),学节点的瞬间就是事实
// 产生时点——learn 命令必须在同事务内窄域定向结算这两族任务,否则奖励被
// 推迟到下次进关/任务页(2026-10-01 时点审计发现 #2:learn 显式 null)。
//
// 窄域契约:learn 只结算自己改变的事实(37/96);开板数(mission 95)由
// open_mana_board 的 cat1 全量结算负责,作为对照组在下方验证。
// awake_mana_node 不改变任何 cat1 状态事实(只写节点觉醒等级),无需结算。

"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test, after } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mana-node-mission-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const {
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { getCharacterGrowthContent } = require("../src/lib/character-growth-content")
const { getCharacterFacts } = require("../src/lib/character-content")
const { characterExpCaps } = require("../src/lib/character")
const getCharacterManaNodesSync = (characterId, level) => getCharacterGrowthContent().getManaBoardNodes(characterId, level)
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const manaRoutes = require("../src/routes/api/character/mana").default
const bondRoutes = require("../src/routes/api/character/bond").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const bundledDegreeTable = require("../assets/mission_degree.json")

initializeDatabase()
db = getDb()

let routeApp
let playerCounter = 930

async function createReachablePlayer() {
    playerCounter += 1
    const viewerId = 930000000 + playerCounter
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mana-node-mission-${playerCounter}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({ id: playerId, stamina: 999 })
    // insertDefaultPlayerSync 已附带初始角色 1,这里只拉满等级与界限突破
    // (角色行不带 rarity,从内容表取真实稀有度以选对经验阶梯)
    const rarity = getCharacterFacts().get(1).rarity
    updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[rarity].at(-1),
        overLimitStep: 4,
    })
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function grantNodeCost(playerId, boardId, nodeIds) {
    const nodes = getCharacterManaNodesSync(1, boardId)
    let mana = 0
    const items = new Map()
    for (const nodeId of nodeIds) {
        const node = nodes[String(nodeId)]
        assert.ok(node, `missing node ${nodeId}`)
        mana += node.manaCost
        for (const [itemId, amount] of Object.entries(node.items)) {
            items.set(itemId, (items.get(itemId) ?? 0) + amount)
        }
    }
    updatePlayerSync({ id: playerId, freeMana: mana, paidMana: 0 })
    for (const [itemId, amount] of items) {
        setInventoryFixtureItemExactSync(playerId, Number(itemId), amount)
    }
}

function seedBoardNodes(playerId, characterId, nodeIds) {
    insertPlayerCharacterManaNodesSync(playerId, characterId, nodeIds)
}

function seedBoardOne(playerId) {
    const nodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    seedBoardNodes(playerId, 1, nodeIds)
    return nodeIds
}

function nodeMissionProgress(playerId, missionId) {
    const row = db.prepare(`
        SELECT progress FROM players_category_missions
        WHERE player_id = ? AND category = 1 AND id = ?
    `).get(playerId, missionId)
    return row?.progress ?? 0
}

function degreeMissionProgress(playerId, missionId) {
    const row = db.prepare(`
        SELECT progress FROM players_category_missions
        WHERE player_id = ? AND category = 5 AND id = ?
    `).get(playerId, missionId)
    return row?.progress ?? 0
}

// 按权威匹配条件取该角色的称号任务(cat5 condition type 44=好感/48=二板完成,
// 与 degree-context-requirements 的 getSpecificCharacterBondId /
// getSecondManaBoardCharacterId 同列同义)
function degreeMissionIdForCharacter(characterId, conditionType) {
    for (const [id, rows] of Object.entries(bundledDegreeTable)) {
        const row = rows[0]
        if (String(row[3]) === String(conditionType)
            && String(row[15]) === String(characterId)) return Number(id)
    }
    return null
}

function post(url, payload) {
    return routeApp.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function learnNodes(viewerId, characterId, nodeIds) {
    return post("/mana/learn_mana_node", {
        viewer_id: viewerId,
        character_id: characterId,
        mana_node_multiplied_id_list: nodeIds,
        api_count: 1,
    })
}

async function openSecondBoard(viewerId) {
    return post("/bond/open_mana_board", {
        viewer_id: viewerId,
        character_id: 1,
        mana_board_index: 2,
        api_count: 1,
    })
}

test.before(async () => {
    routeApp = Fastify({ logger: false })
    routeApp.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(routeApp)
    await routeApp.register(manaRoutes, { prefix: "/mana" })
    await routeApp.register(bondRoutes, { prefix: "/bond" })
    await routeApp.ready()
})

test.after(async () => {
    if (routeApp) await routeApp.close()
    cleanup()
})

test("强化首个节点当场结算任务37阶段1并发放30星导石", async () => {
    const player = await createReachablePlayer()
    const firstNode = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)[0]
    grantNodeCost(player.playerId, 1, [firstNode])

    const stonesBefore = getPlayerSync(player.playerId).freeVmoney
    assert.equal(nodeMissionProgress(player.playerId, 37), 0, "初始进度为 0")

    const response = await learnNodes(player.viewerId, 1, [firstNode])
    assert.equal(response.statusCode, 200, response.body)

    assert.equal(nodeMissionProgress(player.playerId, 37), 1, "节点强化后任务 37 进度必须当场推进")
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore,
        30,
        "任务 37 阶段 1 奖励(30 星导石)必须当场发放",
    )
    const missionInfo = decode(response).data.mission_info ?? []
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 37),
        "learn 响应的 mission_info 必须包含任务 37",
    )
    // 窄域契约:learn 只结算自己改变的事实,开板数(95)不由 learn 代结算
    assert.equal(nodeMissionProgress(player.playerId, 95), 0, "learn 不得代结算开板数任务 95")
})

test("强化跨过多个阶段时奖励逐档累计发放", async () => {
    const player = await createReachablePlayer()
    const boardOneNodes = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    const firstFive = boardOneNodes.slice(0, 5)
    grantNodeCost(player.playerId, 1, firstFive)

    const stonesBefore = getPlayerSync(player.playerId).freeVmoney
    const response = await learnNodes(player.viewerId, 1, firstFive)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(nodeMissionProgress(player.playerId, 37), 5, "学 5 个节点后任务 37 进度必须为 5")
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore,
        60,
        "跨阶段 1(目标 1)与阶段 2(目标 5)必须发放 2×30 星导石",
    )
    const received = db.prepare(`
        SELECT COUNT(*) AS count FROM players_category_mission_stages
        WHERE player_id = ? AND category = 1 AND mission_id = 37 AND status = 1
    `).get(player.playerId).count
    assert.equal(received, 2, "跨过的 2 个阶段必须标记已领取(幂等防重发)")
})

test("开二板当场结算任务95与任务37(对照组:既有开板全量结算路径)", async () => {
    const player = await createReachablePlayer()
    seedBoardOne(player.playerId)
    upsertPlayerCharacterAwakeUnlockSync(player.playerId, 1, 1, 1)
    const stonesBefore = getPlayerSync(player.playerId).freeVmoney

    const open = await openSecondBoard(player.viewerId)
    assert.equal(open.statusCode, 200, open.body)

    assert.equal(nodeMissionProgress(player.playerId, 95), 1, "开板后任务 95 进度必须为 1")
    assert.equal(
        nodeMissionProgress(player.playerId, 37),
        23,
        "板一 23 个节点全部学完,任务 37 进度必须为 23",
    )
    // 开板是首次 cat1 全量结算,会连带发放默认状态已满足的其它终身任务,
    // 因此奖励只断下限;精确发放额由 learn 窄域用例(37/96)验证。
    assert.ok(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore >= 140,
        "开板至少发放任务 37 阶段 1/5/15(3×30)+ 任务 95 阶段 1(50)= 140 星导石",
    )
})

test("板一学满授予信赖之证:当场结算任务39与好感称号(cat5 type44)", async () => {
    const player = await createReachablePlayer()
    const boardOneNodes = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    seedBoardNodes(player.playerId, 1, boardOneNodes.slice(0, -1))
    const lastNode = boardOneNodes.at(-1)
    grantNodeCost(player.playerId, 1, [lastNode])
    const favorMissionId = degreeMissionIdForCharacter(1, 44)
    assert.ok(favorMissionId, "测试前提:角色 1 存在好感称号任务(type 44)")

    const stonesBefore = getPlayerSync(player.playerId).freeVmoney
    const response = await learnNodes(player.viewerId, 1, [lastNode])
    assert.equal(response.statusCode, 200, response.body)

    // 板一完成 + 基础等级帽已满足(Lv100)→ 信赖证授予(status 0→1)
    assert.equal(nodeMissionProgress(player.playerId, 39), 1, "信赖证授予后任务 39 进度必须当场推进")
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore,
        140,
        "任务 37 阶段 1/5/15(3×30)+ 任务 39 阶段 1(50)= 140 星导石",
    )
    // 好感称号(Lv100=1 + 信赖证=1 → target 2)当场完成
    assert.equal(degreeMissionProgress(player.playerId, favorMissionId), 2, "好感称号进度必须当场推进到 2")
    const missionInfo = decode(response).data.mission_info ?? []
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 39),
        "learn 响应的 mission_info 必须包含任务 39",
    )
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 5 && entry.mission_id === favorMissionId),
        "learn 响应的 mission_info 必须包含好感称号任务",
    )
    // 窄域契约:板二相关事实未变化,不得被板一的 learn 代结算
    assert.equal(nodeMissionProgress(player.playerId, 96), 0, "板二未动,任务 96 进度必须保持 0")
    const boardTwoFavorMissionId = degreeMissionIdForCharacter(1, 48)
    assert.equal(
        degreeMissionProgress(player.playerId, boardTwoFavorMissionId),
        0,
        "板二未动,二板完成称号进度必须保持 0",
    )
})

test("二板最后一个节点强化完成当场结算任务96并发放50星导石", async () => {
    const player = await createReachablePlayer()
    seedBoardOne(player.playerId)
    upsertPlayerCharacterAwakeUnlockSync(player.playerId, 1, 1, 1)
    const open = await openSecondBoard(player.viewerId)
    assert.equal(open.statusCode, 200, open.body)
    const stonesAfterOpen = getPlayerSync(player.playerId).freeVmoney

    const boardTwoNodes = Object.keys(getCharacterManaNodesSync(1, 2)).map(Number)
    assert.equal(boardTwoNodes.length, 18, "测试前提:板二 18 个节点")
    seedBoardNodes(player.playerId, 1, boardTwoNodes.slice(0, -1))
    const lastNode = boardTwoNodes.at(-1)
    grantNodeCost(player.playerId, 2, [lastNode])

    const response = await learnNodes(player.viewerId, 1, [lastNode])
    assert.equal(response.statusCode, 200, response.body)

    assert.equal(nodeMissionProgress(player.playerId, 96), 1, "二板全部强化完成必须当场推进任务 96")
    assert.equal(
        nodeMissionProgress(player.playerId, 37),
        41,
        "任务 37 进度为 23+18=41(未跨新阶段,不重复发放)",
    )
    // 板二完成触发信赖证授予(板二无等级条件)→ 任务 39 当场推进;
    // 二板完成称号(cat5 type 48)同事务当场结算
    assert.equal(nodeMissionProgress(player.playerId, 39), 1, "信赖证授予后任务 39 进度必须当场推进")
    const boardTwoFavorMissionId = degreeMissionIdForCharacter(1, 48)
    assert.ok(boardTwoFavorMissionId, "测试前提:角色 1 存在二板完成称号任务(type 48)")
    assert.equal(
        degreeMissionProgress(player.playerId, boardTwoFavorMissionId),
        1,
        "二板完成称号进度必须当场推进到 1",
    )
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesAfterOpen,
        130,
        "跨任务 37 阶段 4(目标 30,进度 23→41)+ 任务 96 阶段 1(50)+ 任务 39 阶段 1(50)= 130 星导石",
    )
    const missionInfo = decode(response).data.mission_info ?? []
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 96),
        "learn 响应的 mission_info 必须包含任务 96",
    )
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 39),
        "learn 响应的 mission_info 必须包含任务 39",
    )
})
