// 界限突破(over_limit / bulk_over_limit)的任务结算回归:
// 「累计上限突破」(mission 38, over_limit_total_count,阶段目标
// 1/5/10/30/50/70/100/150/200,阶段 1 奖 100 星导石、其余各 30)是状态派生
// 任务(各角色 overLimitStep 求和现算),突破的瞬间就是事实产生时点——
// over_limit 命令必须在同事务内窄域结算,否则奖励被推迟到下次进关/任务页。
// 称号族(cat5 degree_overlimit_growth_,4000/4010/4020,目标 10/350/1000)
// 同一事实时点;condition 9 不在战斗 finish 的 degree 结算白名单内。

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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "over-limit-mission-"))
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
    getPlayerCharacterSync,
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { getCharacterFacts } = require("../src/lib/character-content")
const { characterMaxOverLimits } = require("../src/lib/character-growth/limits")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const characterRoutes = require("../src/routes/api/character").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const bundledDegreeTable = require("../assets/mission_degree.json")

initializeDatabase()
db = getDb()

let routeApp
let playerCounter = 950

async function createReachablePlayer() {
    playerCounter += 1
    const viewerId = 950000000 + playerCounter
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `over-limit-mission-${playerCounter}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({ id: playerId, stamina: 999 })
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
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

// 与 degree-context-requirements 的 DEGREE_SUPPORTED_FAMILIES.overLimitCount
// 同前缀同义,取捆绑主数据中的称号任务 ID
function overLimitDegreeMissionIds() {
    return Object.entries(bundledDegreeTable)
        .filter(([, rows]) => String(rows[0][1] ?? "").startsWith("degree_overlimit_growth_"))
        .map(([id]) => Number(id))
        .sort((left, right) => left - right)
}

// 给角色塞满可突破次数所需的双生影(stack),返回该角色可突破的总步数
// (默认玩家已附带角色 1,重复插入会撞主键,这里按需补插)
function seedStack(playerId, characterId) {
    if (getPlayerCharacterSync(playerId, characterId) === null) {
        insertDefaultPlayerCharacterSync(playerId, characterId)
    }
    const rarity = getCharacterFacts().get(characterId).rarity
    const max = characterMaxOverLimits[rarity]
    assert.ok(max, `测试前提:角色 ${characterId} 稀有度 ${rarity} 有上限突破档位`)
    updatePlayerCharacterSync(playerId, characterId, { stack: max })
    return max
}

test("单个界限突破当场结算任务38阶段1并发放100星导石", async () => {
    const player = await createReachablePlayer()
    seedStack(player.playerId, 1)

    const stonesBefore = getPlayerSync(player.playerId).freeVmoney
    assert.equal(nodeMissionProgress(player.playerId, 38), 0, "初始进度为 0")

    const response = await post("/character/over_limit", {
        viewer_id: player.viewerId,
        character_id: 1,
        over_limit_count: 1,
        use_stack: true,
        api_count: 1,
    })
    assert.equal(response.statusCode, 200, response.body)

    assert.equal(nodeMissionProgress(player.playerId, 38), 1, "突破后任务 38 进度必须当场推进")
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore,
        100,
        "任务 38 阶段 1 奖励(100 星导石)必须当场发放",
    )
    const missionInfo = decode(response).data.mission_info ?? []
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 38),
        "over_limit 响应的 mission_info 必须包含任务 38",
    )
    // 窄域契约:突破不改信赖证事实,任务 39 不得被代结算
    assert.equal(nodeMissionProgress(player.playerId, 39), 0, "突破不得代结算信赖证任务 39")
})

test("批量界限突破当场结算任务38多阶段与突破称号族(cat5)", async () => {
    const player = await createReachablePlayer()
    // 三个角色全部突破到各自上限:4星1人(6)+ 3星2人(8+8)= 22 步
    const totalSteps = seedStack(player.playerId, 1)
        + seedStack(player.playerId, 341005)
        + seedStack(player.playerId, 341011)
    assert.ok(totalSteps >= 10, "测试前提:总步数覆盖称号 4000 的目标 10")
    const [degreeSmall, degreeMiddle] = overLimitDegreeMissionIds()
    assert.ok(degreeSmall && degreeMiddle, "测试前提:称号族存在")

    const stonesBefore = getPlayerSync(player.playerId).freeVmoney
    const response = await post("/character/bulk_over_limit", {
        viewer_id: player.viewerId,
        api_count: 1,
    })
    assert.equal(response.statusCode, 200, response.body)

    assert.equal(nodeMissionProgress(player.playerId, 38), totalSteps, "批量突破后任务 38 进度必须当场推进")
    assert.equal(
        getPlayerSync(player.playerId).freeVmoney - stonesBefore,
        160,
        "任务 38 阶段 1/5/10(100+30+30)= 160 星导石",
    )
    assert.equal(
        degreeMissionProgress(player.playerId, degreeSmall),
        totalSteps,
        "突破称号(目标 10)进度必须当场推进",
    )
    assert.equal(
        degreeMissionProgress(player.playerId, degreeMiddle),
        totalSteps,
        "更高档称号进度推进但不发奖(未达目标)",
    )
    const missionInfo = decode(response).data.mission_info ?? []
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 38),
        "bulk_over_limit 响应的 mission_info 必须包含任务 38",
    )
    assert.ok(
        missionInfo.some(entry => entry.mission_category_id === 5 && entry.mission_id === degreeSmall),
        "bulk_over_limit 响应的 mission_info 必须包含突破称号",
    )
    // 跨过称号阶段时,响应当场携带 degree_list(称号发布),不依赖任务页
    const degreeList = decode(response).data.degree_list ?? []
    assert.ok(
        degreeList.some(entry => entry.degree_id === degreeSmall),
        "bulk_over_limit 响应的 degree_list 必须包含突破称号",
    )
})

test.before(async () => {
    routeApp = Fastify({ logger: false })
    routeApp.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(routeApp)
    await routeApp.register(characterRoutes, { prefix: "/character" })
    await routeApp.ready()
})

test.after(async () => {
    if (routeApp) await routeApp.close()
    cleanup()
})
