"use strict"

// 旧局迟到的 finish 幂等终态回归:play_id 与当前活跃任务不一致时,
// 必须返回 200 + clear_rank=0 + 零奖励的完整响应,且绝不能影响新一局
// (不结算、不删除活跃任务、不写进度)。重复 finish 也不得重复发奖。
// 背景(2026-10-05 查证):原实现按 playerId 取活跃任务、从不校验 play_id,
// 旧 body 会把新一局提前结算;参考服同型事故即 H400/重复发奖源头之一。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stale-finish-db-"))
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, getPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    getPlayerSingleQuestProgressSync,
    insertPlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

initializeDatabase()
db = getDb()

const QUEST_ID = 7014002
const PREREQUISITES = [7013001, 7013002, 7013003, 7013004]

let playerSeq = 0

async function createPlayer() {
    playerSeq += 1
    const viewerId = 840000000 + playerSeq
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `stale-finish-${playerSeq}-${randomUUID()}`,
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

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
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
            is_accomplished: true,
            is_lose: false,
            is_restored: false,
            continue_count: 0,
            statistics: battleStatistics(),
            ...overrides,
        })

        // ===== 第一局:正常通关,拿到基线状态 =====
        const a = await createPlayer()
        seedPrerequisites(a.playerId)
        const start1 = await startQuest(a.viewerId, QUEST_ID, "stale-play-1")
        assert.equal(start1.statusCode, 200, `首局 start 必须成功: ${start1.body}`)
        const before = { vmoney: getPlayerSync(a.playerId).freeVmoney }
        const finish1 = await finishQuest(a.viewerId, QUEST_ID, "stale-play-1")
        assert.equal(finish1.statusCode, 200, `首局 finish 必须成功: ${finish1.body}`)
        const first = unpack(Buffer.from(finish1.body, "base64"))
        assert.equal(first.data.clear_rank, 5, "快败即 SS")
        const afterFirst = {
            vmoney: getPlayerSync(a.playerId).freeVmoney,
            progress: getPlayerSingleQuestProgressSync(a.playerId, 1, QUEST_ID),
        }
        assert.ok(afterFirst.vmoney - before.vmoney > 0, "首通奖励必须发放")
        assert.equal(afterFirst.progress.finished, true)

        // ===== 第二局开局后,用第一局的 play_id 迟到提交 =====
        const start2 = await startQuest(a.viewerId, QUEST_ID, "stale-play-2")
        assert.equal(start2.statusCode, 200, "第二局 start 必须成功")
        assert.equal(getPlayerActiveQuestSync(a.playerId)?.playId, "stale-play-2")
        const beforeStale = { vmoney: getPlayerSync(a.playerId).freeVmoney }

        const staleFinish = await finishQuest(a.viewerId, QUEST_ID, "stale-play-1")
        assert.equal(staleFinish.statusCode, 200, "旧局迟到 finish 必须返回幂等 200 而非 400/H400")
        const stale = unpack(Buffer.from(staleFinish.body, "base64"))
        assert.equal(stale.data.clear_rank, 0, "幂等终态必须 clear_rank=0")
        assert.equal(stale.data.rewards.reward_mana, 0, "幂等终态必须零奖励")
        assert.deepEqual(stale.data.item_list, {}, "幂等终态必须零道具")
        assert.equal(
            getPlayerSync(a.playerId).freeVmoney,
            beforeStale.vmoney,
            "迟到提交不得重复发放任何奖励",
        )
        assert.equal(
            getPlayerActiveQuestSync(a.playerId)?.playId,
            "stale-play-2",
            "迟到提交不得删除新一局的活跃任务",
        )
        const progressAfterStale = getPlayerSingleQuestProgressSync(a.playerId, 1, QUEST_ID)
        assert.deepEqual(
            [progressAfterStale.finished, progressAfterStale.singleClearCount],
            [afterFirst.progress.finished, afterFirst.progress.singleClearCount],
            "迟到提交不得推进关卡进度档案",
        )

        // ===== 第二局正常结算不受影响 =====
        const finish2 = await finishQuest(a.viewerId, QUEST_ID, "stale-play-2")
        assert.equal(finish2.statusCode, 200, "新一局正常结算必须不受迟到提交影响")
        assert.equal(getPlayerActiveQuestSync(a.playerId), null, "正常结算后活跃任务清空")

        console.log("single finish stale play tests passed")
    } finally {
        await fastify.close()
    }
}

main()
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
