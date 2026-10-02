// 经验池注入(/expod/inject_exp)的任务结算回归:
// 角色等级是状态派生事实(exp 现算),注入跨过等级阈值后,**同一响应内**必须
// 结算并发放角色等级任务(mission 9,阶段目标 10/20/.../100,奖励=星导石×
// 阶梯值)与等级称号(3000/3010/3020)——不得延迟到下次进关/任务页。
// 背景:用户实测「角色达到 N 级」任务在进关时才提示完成(经验注入路径无结算)。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inject-exp-mission-db-"))
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

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerSync,
    getPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getCharacterGrowthContent } = require("../src/lib/character-growth-content")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

initializeDatabase()
db = getDb()

const CHARACTER_ID = 341005
const INJECT_EXP_TO_LEVEL_60 = 37241 // 3 星角色:该累计经验实际达到 Lv60(实测曲线)

let playerCounter = 900

async function createPlayer() {
    playerCounter += 1
    const viewerId = 840000000 + playerCounter
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `inject-exp-mission-${playerCounter}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({ id: playerId, expPool: 60000, stamina: 999 })
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

function missionProgress(playerId, missionId) {
    const row = db.prepare(`
        SELECT progress FROM players_category_missions
        WHERE player_id = ? AND category = 1 AND id = ?
    `).get(playerId, missionId)
    return row?.progress ?? 0
}

async function main() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    const { default: expodRoutes } = require("../src/routes/api/expod")
    await fastify.register(expodRoutes, { prefix: "/api/index.php/expod" })
    await fastify.ready()

    try {
        const { playerId, viewerId } = await createPlayer()
        insertDefaultPlayerCharacterSync(playerId, CHARACTER_ID)
        const vmoneyBefore = getPlayerSync(playerId).freeVmoney

        // 注入跨越 Lv45 阈值的经验
        const inject = await post(fastify, "/api/index.php/expod/inject_exp", {
            viewer_id: viewerId,
            character_id: CHARACTER_ID,
            exp: INJECT_EXP_TO_LEVEL_60,
        })
        assert.equal(inject.statusCode, 200, inject.body)

        // 注入响应当场携带任务完成信息(mission_info),不依赖进关/轮询
        const missionInfo = decode(inject).data.mission_info ?? []
        assert.ok(
            missionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 9),
            "注入响应的 mission_info 必须包含角色等级任务",
        )
        // 跨过 Lv60 时等级称号(cat5 3000)完成,degree_list 当场发布
        const degreeList = decode(inject).data.degree_list ?? []
        assert.ok(
            degreeList.some(entry => entry.degree_id === 3000),
            "注入响应的 degree_list 必须包含 Lv60 称号",
        )

        // 任务 9(角色等级)进度当场推进到 60,不依赖进关/轮询
        assert.equal(
            missionProgress(playerId, 9),
            60,
            "经验注入后角色等级任务进度必须当场结算(Lv60,实测曲线)",
        )

        // 跨过的 6 个阶段(Lv10/20/30/40/50/60)奖励当场发放:每档 10 星导石
        const vmoneyAfter = getPlayerSync(playerId).freeVmoney
        assert.equal(
            vmoneyAfter - vmoneyBefore,
            60,
            "跨越 6 个等级阶段必须发放 6×10 星导石",
        )
        // 阶段领取记录落库(幂等防重发)
        const received = db.prepare(`
            SELECT COUNT(*) AS count FROM players_category_mission_stages
            WHERE player_id = ? AND category = 1 AND mission_id = 9 AND status = 1
        `).get(playerId).count
        assert.equal(received, 6, "跨越的 6 个等级阶段必须标记已领取")

        // 对照:再次注入少量经验(不跨新阶段,45→48)→ 无新阶段、无新奖励
        const inject2 = await post(fastify, "/api/index.php/expod/inject_exp", {
            viewer_id: viewerId,
            character_id: CHARACTER_ID,
            exp: 3000,
        })
        assert.equal(inject2.statusCode, 200, inject2.body)
        assert.equal(
            missionProgress(playerId, 9),
            60,
            "未跨新阶段时进度保持不变",
        )
        assert.equal(
            getPlayerSync(playerId).freeVmoney - vmoneyAfter,
            0,
            "未跨新阶段不得重复发放阶段奖励",
        )

        // 羁绊之证场景:板一节点全部学完 + 注入跨基础等级帽(37241)且达 Lv80
        // → 信赖证授予(status 0→1)必须在注入响应内当场结算任务 39、
        // Lv80 角色数任务(36)与该角色好感称号(cat5 type 44)
        const bondPlayer = await createPlayer()
        insertDefaultPlayerCharacterSync(bondPlayer.playerId, CHARACTER_ID)
        // 界限突破 4 档:经验帽抬到 caps[3][4]=125223,否则注入被钳回基础帽
        updatePlayerCharacterSync(bondPlayer.playerId, CHARACTER_ID, { overLimitStep: 4 })
        updatePlayerSync({ id: bondPlayer.playerId, expPool: 300000 })
        const boardNodes = getCharacterGrowthContent().getManaBoardNodes(CHARACTER_ID, 1)
        insertPlayerCharacterManaNodesSync(
            bondPlayer.playerId,
            CHARACTER_ID,
            Object.keys(boardNodes).map(Number),
        )
        const vmoneyBondBefore = getPlayerSync(bondPlayer.playerId).freeVmoney
        const injectBond = await post(fastify, "/api/index.php/expod/inject_exp", {
            viewer_id: bondPlayer.viewerId,
            character_id: CHARACTER_ID,
            exp: 125223, // caps[3][4]:3 星角色 Lv80 阈值(基础 60 级),同时跨过基础帽 37241
        })
        assert.equal(injectBond.statusCode, 200, injectBond.body)
        assert.equal(
            missionProgress(bondPlayer.playerId, 9),
            80,
            "角色等级任务进度必须当场推进到 Lv80(3 星上限)",
        )
        assert.equal(
            missionProgress(bondPlayer.playerId, 36),
            1,
            "Lv80 角色数任务(36)进度必须当场推进到 1",
        )
        assert.equal(
            missionProgress(bondPlayer.playerId, 39),
            1,
            "信赖证授予后任务 39 进度必须当场推进到 1",
        )
        assert.equal(
            getPlayerSync(bondPlayer.playerId).freeVmoney - vmoneyBondBefore,
            200,
            "任务 9 七档 70 + Lv80 档 50 + 任务 36 阶段 1(30)+ 任务 39 阶段 1(50)= 200 星导石",
        )
        // 注入响应当场携带完成信息(mission_info),不依赖进关/轮询
        const bondMissionInfo = decode(injectBond).data.mission_info ?? []
        assert.ok(
            bondMissionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 36),
            "注入响应的 mission_info 必须包含 Lv80 角色数任务",
        )
        assert.ok(
            bondMissionInfo.some(entry => entry.mission_category_id === 1 && entry.mission_id === 39),
            "注入响应的 mission_info 必须包含任务 39",
        )
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("inject exp mission settlement tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
