// LoseBattle(允许失败)主线关卡结算回归:主线 7014002(第 7 章魔王战「不速之客」)
// 是全主线唯一的 NormalQuestKind.LoseBattle(col49=2)。
//
// 最终语义(用户 2026-10-01 拍板):败北通关 = 等同正常 SS 通关的全部结算——
// 进度 finished、评级按用时(快败即 SS)、首通奖励 + S+ 评级奖励(30 石)、
// SS 档分数材料、体力 commit 不返还;唯一例外:**任务战斗计数保持真实败北
// 语义**(不计通关/SS 次数)——这是上一次撤回的核心原因(败北计入"通关
// 关卡"任务计数),本测试是它的回归锁。
//
// 双因子触发:客户端 is_lose=true + 服务端 questKind=2,缺一即普通失败。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lose-battle-db-"))
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
const { insertDefaultPlayerSync, getPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerSingleQuestProgressSync,
    insertPlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { updatePlayerSync } = require("../src/data/domains/player")
const { SessionType } = require("../src/data/types")

initializeDatabase()
db = getDb()

const LOSE_BATTLE_QUEST_ID = 7014002
const NON_LOSE_BATTLE_QUEST_ID = 7013004
const PREREQUISITES = [7013001, 7013002, 7013003, 7013004]

let playerSeq = 0

async function createPlayer() {
    playerSeq += 1
    const viewerId = 830000000 + playerSeq
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `lose-battle-${playerSeq}-${randomUUID()}`,
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

function seedPrerequisites(playerId) {
    for (const questId of PREREQUISITES) {
        insertPlayerQuestProgressSync(playerId, 1, {
            questId,
            finished: true,
            clearRank: 5,
        })
    }
}

function counters(playerId) {
    return db.prepare(`
        SELECT single_play_count, single_clear_count, single_rank_ss_count
        FROM players_mission_battle_counters WHERE player_id = ?
    `).get(playerId) ?? { single_play_count: 0, single_clear_count: 0, single_rank_ss_count: 0 }
}

function materialTotal(playerId) {
    return db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM players_items
        WHERE player_id = ? AND id IN (42, 43, 44)
    `).get(playerId).total
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

function battleStatistics() {
    return {
        clear_phase: 1,
        max_combo_count: 0,
        zones: [{
            damage_deal_total: 0,
            members: [{ origin_damage: 0 }, null, null],
        }],
        party: {
            characters: [{ id: 341005 }, null, null],
            unison_characters: [null, null, null],
            equipments: [null, null, null],
            ability_soul_ids: [null, null, null],
        },
    }
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
    const { default: singleBattleRoutes } = require("../src/routes/api/singleBattleQuest")
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.ready()

    try {
        const startQuest = (viewerId, questId, playId) => post(fastify, "/api/index.php/single_battle_quest/start", {
            viewer_id: viewerId,
            api_count: 1,
            party_id: 1,
            quest_id: questId,
            category: 1,
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
            play_id: playId,
        })
        const finishQuest = (viewerId, questId, playId, overrides = {}) => post(fastify, "/api/index.php/single_battle_quest/finish", {
            viewer_id: viewerId,
            api_count: 1,
            play_id: playId,
            quest_id: questId,
            category: 1,
            score: 0,
            elapsed_time_ms: 33651,
            add_mana: 0,
            is_accomplished: false,
            is_restored: false,
            continue_count: 0,
            statistics: battleStatistics(),
            ...overrides,
        })

        // ===== 场景 1:败北通关(核心语义)=====
        const a = await createPlayer()
        seedPrerequisites(a.playerId)
        const staminaBeforeStart = getPlayerSync(a.playerId).stamina
        const start1 = await startQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-1")
        assert.equal(start1.statusCode, 200, `start 必须成功: ${start1.body}`)
        const staminaAfterStart = getPlayerSync(a.playerId).stamina
        assert.equal(
            staminaAfterStart,
            staminaBeforeStart - 14,
            "入场必须扣除 14 体力",
        )
        const before = { vmoney: getPlayerSync(a.playerId).freeVmoney, materials: materialTotal(a.playerId), counters: counters(a.playerId) }

        const finish1 = await finishQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-1", {
            is_lose: true,
        })
        assert.equal(finish1.statusCode, 200, `败北通关必须 200: ${finish1.body}`)

        // 进度:finished=true + 评级按用时(SS=5)
        const progress = getPlayerSingleQuestProgressSync(a.playerId, 1, LOSE_BATTLE_QUEST_ID)
        assert.ok(progress, "败北通关必须写入进度")
        assert.equal(progress.finished, true, "败北必须标记通关")
        assert.equal(progress.clearRank, 5, "评级按用时计算(快败即 SS)——用户确认 SS 语义正确")

        // 奖励:首通 15 石 + S+ 评级奖励 10 石 = 25 石
        //(官方源数据 col72 sPlusRewardId=4;旧 assets 缺字段时的
        // 「官方未配置」结论系再生前坏数据所致,main_quest 再生已忠实转写)
        const after = { vmoney: getPlayerSync(a.playerId).freeVmoney, materials: materialTotal(a.playerId), counters: counters(a.playerId) }
        assert.equal(
            after.vmoney - before.vmoney,
            25,
            "首通 15 石 + S+ 评级奖励 10 石(官方 col72=4)必须足额发放",
        )
        assert.ok(
            after.materials - before.materials >= 1,
            "SS 档分数材料(暗元素系)必须掉落",
        )

        // ===== 场景 2:任务计数例外(本专项的核心修正)=====
        assert.equal(
            after.counters.single_clear_count,
            before.counters.single_clear_count,
            "败北通关不得计入 single_clear_count(任务战斗计数保持真实败北语义)",
        )
        assert.equal(
            after.counters.single_rank_ss_count,
            before.counters.single_rank_ss_count,
            "败北通关不得计入 SS 评价次数",
        )
        // 体力:commit 不返还
        assert.equal(
            getPlayerSync(a.playerId).stamina,
            staminaAfterStart,
            "败北通关体力 commit 扣除,不返还",
        )

        // ===== 场景 3:重复败北(核心例外:通关计数保持 0)=====
        const start2 = await startQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-2")
        assert.equal(start2.statusCode, 200, start2.body)
        const stable = {
            clearCount: counters(a.playerId).single_clear_count,
            progress: getPlayerSingleQuestProgressSync(a.playerId, 1, LOSE_BATTLE_QUEST_ID),
        }
        const finish2 = await finishQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-2", {
            is_lose: true,
        })
        assert.equal(finish2.statusCode, 200, finish2.body)
        const afterRepeat = {
            clearCount: counters(a.playerId).single_clear_count,
            progress: getPlayerSingleQuestProgressSync(a.playerId, 1, LOSE_BATTLE_QUEST_ID),
        }
        assert.equal(
            afterRepeat.clearCount,
            stable.clearCount,
            "重复败北不得计入通关计数(任务战斗计数的败北语义例外)",
        )
        assert.equal(afterRepeat.progress.finished, true, "进度保持已通关")
        // 进度驱动类任务(通关主线 7-14-2)由 finished 驱动自然完成——正确语义,
        // 其阶段奖励(星导石/材料)随重复通关正常发放,不属于关卡收益,不断言稳定。

        // ===== 场景 4:真胜利 → 任务计数正常 +1(对照组)=====
        const start3 = await startQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-3")
        assert.equal(start3.statusCode, 200, start3.body)
        const countersBeforeWin = counters(a.playerId)
        const winFinish = await finishQuest(a.viewerId, LOSE_BATTLE_QUEST_ID, "lose-play-3", {
            is_accomplished: true,
            score: 163661317,
            elapsed_time_ms: 2737,
        })
        assert.equal(winFinish.statusCode, 200, winFinish.body)
        assert.equal(
            counters(a.playerId).single_clear_count,
            countersBeforeWin.single_clear_count + 1,
            "真胜利必须计入通关计数(对照组)",
        )

        // ===== 场景 5:双因子边界 =====
        // 5a. 非 LoseBattle 关卡伪造 is_lose → 普通失败(无进度)
        // 7013004 的前置链是 7012001-3(quest_prerequisites.json),只补前置,
        // 不预写 7013004 自身的通关进度(否则断言撞上种子数据)。
        const b = await createPlayer()
        for (const questId of [7012001, 7012002, 7012003]) {
            insertPlayerQuestProgressSync(b.playerId, 1, { questId, finished: true, clearRank: 5 })
        }
        const forgedStart = await startQuest(b.viewerId, NON_LOSE_BATTLE_QUEST_ID, "forged-play-1")
        assert.equal(forgedStart.statusCode, 200, forgedStart.body)
        const forgedFinish = await finishQuest(b.viewerId, NON_LOSE_BATTLE_QUEST_ID, "forged-play-1", {
            is_lose: true,
        })
        assert.equal(forgedFinish.statusCode, 200, forgedFinish.body)
        assert.equal(
            getPlayerSingleQuestProgressSync(b.playerId, 1, NON_LOSE_BATTLE_QUEST_ID),
            null,
            "非 LoseBattle 关卡伪造 is_lose 不得写入通关进度",
        )
        // 5b. LoseBattle 关卡不带 is_lose 的败北 → 普通失败(客户端未按契约标记)
        const c = await createPlayer()
        seedPrerequisites(c.playerId)
        const noMarkerStart = await startQuest(c.viewerId, LOSE_BATTLE_QUEST_ID, "no-marker-play-1")
        assert.equal(noMarkerStart.statusCode, 200, noMarkerStart.body)
        const noMarkerFinish = await finishQuest(c.viewerId, LOSE_BATTLE_QUEST_ID, "no-marker-play-1", {})
        assert.equal(noMarkerFinish.statusCode, 200, noMarkerFinish.body)
        assert.equal(
            getPlayerSingleQuestProgressSync(c.playerId, 1, LOSE_BATTLE_QUEST_ID),
            null,
            "未带 is_lose 标记的败北保持失败语义(无兜底,对齐问题必须暴露)",
        )
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("lose battle settlement tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
