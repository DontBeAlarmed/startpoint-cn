require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ranking-event-route-db-"))
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
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const rankingEventRoutes = require("../src/routes/api/rankingEvent").default

initializeDatabase()
db = getDb()

function createPlayer(label, viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `ranking-event-${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)
    updatePlayerCharacterSync(playerId, 341005, { evolutionLevel: 2 })
    if (viewerId !== null) {
        db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
            .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    }
    return playerId
}

const viewerId = 800000296
const playerId = createPlayer("viewer", viewerId)
const rivalId = createPlayer("rival", null)

async function post(fastify, url, payload) {
    return fastify.inject({ method: "POST", url, payload })
}

function decode(response) {
    return unpack(response.rawPayload)
}

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(rankingEventRoutes)
    await fastify.ready()

    try {
        const empty = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 1,
            quest_kind: 1,
        })
        assert.equal(empty.statusCode, 200, empty.body)
        assert.deepEqual(decode(empty).data, { best_record: null })

        for (const payload of [
            { viewer_id: viewerId, ranking_event_id: 1, quest_kind: 2 },
            { viewer_id: viewerId, ranking_event_id: 999999, quest_kind: 1 },
        ]) {
            const response = await post(fastify, "/get_summary", payload)
            assert.equal(response.statusCode, 400)
        }

        insertPlayerQuestProgressSync(playerId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 123456,
            bestElapsedTimeMs: 1000,
            leaderCharacterId: 341005,
        })
        insertPlayerQuestProgressSync(rivalId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 999999,
            bestElapsedTimeMs: 500,
            leaderCharacterId: 341005,
        })

        const summary = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 1,
            quest_kind: 1,
        })
        assert.equal(summary.statusCode, 200, summary.body)
        assert.deepEqual(decode(summary).data, {
            best_record: {
                elapsed_time_ms: 1000,
                is_accomplished: true,
                score: 123456,
            },
            leader_character_evolution_img_level: 2,
            leader_character_id: 341005,
            rank_border_top: {
                elapsed_time_ms: 500,
                is_accomplished: true,
                score: 999999,
            },
            rank_percentage: 50,
        })

        insertPlayerQuestProgressSync(playerId, 11, {
            questId: 2001,
            finished: false,
            unlocked: true,
            highScore: 100,
            leaderCharacterId: 341005,
        })
        insertPlayerQuestProgressSync(rivalId, 11, {
            questId: 2001,
            finished: false,
            unlocked: true,
            highScore: 200,
            leaderCharacterId: 341005,
        })
        const scoreOnlySummary = await post(fastify, "/get_summary", {
            viewer_id: viewerId,
            ranking_event_id: 2,
            quest_kind: 1,
        })
        assert.equal(scoreOnlySummary.statusCode, 200, scoreOnlySummary.body)
        assert.deepEqual(decode(scoreOnlySummary).data.best_record, {
            elapsed_time_ms: 0,
            is_accomplished: false,
            score: 100,
        })
        assert.equal(decode(scoreOnlySummary).data.rank_percentage, 50)

        // --- receive_reward:官方决策表(3 无可领 / 1 首领 / 2 重复) ---
        // 档位选行与客户端 getRankRating 同源:首个 rankBorder >= rank_percentage/100 的行。
        // 期望奖励从官方领奖表读取(不硬编码),与发放共表保证"显示=所得"。
        const rankingRewardTable = require("../assets/ranking_event_ranking_reward.json")
        function selectTier(eventId, rankPercentage) {
            const tiers = rankingRewardTable[String(eventId)]
            const ratio = rankPercentage / 100
            return tiers.find(tier => tier.rankBorder >= ratio) ?? tiers[tiers.length - 1]
        }
        function captureClaimState(pid) {
            const player = getPlayerSync(pid)
            return {
                freeVmoney: player.freeVmoney,
                freeMana: player.freeMana,
                items: db.prepare(
                    "SELECT id, amount FROM players_items WHERE player_id = ? ORDER BY id",
                ).all(pid),
                degrees: db.prepare(
                    "SELECT degree_id FROM players_degrees WHERE player_id = ? ORDER BY degree_id",
                ).all(pid).map(row => row.degree_id),
                claimed: db.prepare(
                    "SELECT COUNT(*) AS count FROM players_ranking_reward_claims WHERE player_id = ? AND ranking_event_id = 1",
                ).get(pid).count,
            }
        }
        function expectedGrantsFromTier(tier) {
            const grants = { items: {}, freeVmoney: 0, freeMana: 0, degrees: [] }
            for (const reward of tier.rewards) {
                if (reward.kind === 0) grants.items[reward.id] = (grants.items[reward.id] ?? 0) + reward.amount
                else if (reward.kind === 2) grants.freeVmoney += reward.amount
                else if (reward.kind === 3) grants.freeMana += reward.amount
                else if (reward.kind === 7) grants.degrees.push(reward.id)
                else throw new Error("unexpected ranking reward kind: " + reward.kind)
            }
            grants.degrees.sort((left, right) => left - right)
            return grants
        }
        function itemDelta(before, after) {
            const items = {}
            for (const row of after.items) {
                const beforeAmount = before.items.find(entry => entry.id === row.id)?.amount ?? 0
                if (row.amount !== beforeAmount) items[row.id] = row.amount - beforeAmount
            }
            return items
        }
        function degreeDelta(before, after) {
            return after.degrees.filter(id => !before.degrees.includes(id))
        }

        // 冠军玩家(最快成绩 → 百分位 0 → 满档)与回滚玩家
        const championId = createPlayer("champion", 800000298)
        insertPlayerQuestProgressSync(championId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 777777,
            bestElapsedTimeMs: 300,
            leaderCharacterId: 341005,
        })
        const rollbackId = createPlayer("rollback", 800000299)
        insertPlayerQuestProgressSync(rollbackId, 11, {
            questId: 1001,
            finished: true,
            unlocked: true,
            highScore: 111,
            bestElapsedTimeMs: 999,
            leaderCharacterId: 341005,
        })
        // champion 与 rollback 加入后,quest 1001 共 4 人;viewer 有 3 人优于
        const viewerPercentile = 3 / 4 * 100

        // 满档玩家首领 → status 1 + 满档奖励 + 完整摘要
        const championBefore = captureClaimState(championId)
        const championReward = await post(fastify, "/receive_reward", {
            viewer_id: 800000298,
            ranking_event_id: 1,
        })
        assert.equal(championReward.statusCode, 200, championReward.body)
        assert.ok(
            String(championReward.headers["content-type"]).includes("application/x-msgpack"),
            "领奖响应必须保持 application/x-msgpack 协议形状",
        )
        const championData = decode(championReward).data
        assert.equal(championData.status, 1, "首次领取返回 status=1")
        assert.equal(championData.best_record.elapsed_time_ms, 300)
        assert.equal(championData.best_record.is_accomplished, true)
        assert.equal(championData.rank_percentage, 0.5, "并列第一的百分位钳制为客户端合法下界 0.5")
        assert.equal(championData.leader_character_id, 341005)
        assert.deepEqual(championData.rank_border_top, {
            elapsed_time_ms: 300,
            is_accomplished: true,
            score: 777777,
        }, "rank_border_top 必须是本服真实榜首记录(此处即冠军本人)")
        assert.equal(captureClaimState(championId).claimed, 1, "首领成功必须写入领取记录")
        const championTier = selectTier(1, 0.5)
        const championGrants = expectedGrantsFromTier(championTier)
        const championAfter = captureClaimState(championId)
        assert.deepEqual(
            degreeDelta(championBefore, championAfter),
            championGrants.degrees,
            "首领必须按满档发放称号",
        )
        assert.equal(
            championAfter.freeVmoney - championBefore.freeVmoney,
            championGrants.freeVmoney,
            "Stone 槽必须按满档发放为 freeVmoney",
        )
        assert.deepEqual(
            itemDelta(championBefore, championAfter),
            championGrants.items,
            "Item 槽必须按满档发放",
        )

        // 重复领取 → status 2 + 同一摘要,且无任何新增发放
        const championStable = captureClaimState(championId)
        const championRepeat = await post(fastify, "/receive_reward", {
            viewer_id: 800000298,
            ranking_event_id: 1,
        })
        assert.equal(championRepeat.statusCode, 200, championRepeat.body)
        const championRepeatData = decode(championRepeat).data
        assert.equal(championRepeatData.status, 2, "重复领取返回 status=2")
        assert.equal(championRepeatData.rank_percentage, 0.5, "重复领取携带同一摘要")
        assert.deepEqual(captureClaimState(championId), championStable, "重复领取不得再次发放")

        // viewer(百分位 2/3)首领 → 按同一规则落到低档
        const viewerBefore = captureClaimState(playerId)
        const viewerReward = await post(fastify, "/receive_reward", {
            viewer_id: viewerId,
            ranking_event_id: 1,
        })
        assert.equal(viewerReward.statusCode, 200, viewerReward.body)
        const viewerData = decode(viewerReward).data
        assert.equal(viewerData.status, 1)
        assert.equal(viewerData.rank_percentage, viewerPercentile, "摘要百分位与选档同源")
        const viewerGrants = expectedGrantsFromTier(selectTier(1, viewerPercentile))
        const viewerAfter = captureClaimState(playerId)
        assert.deepEqual(degreeDelta(viewerBefore, viewerAfter), viewerGrants.degrees)
        assert.equal(viewerAfter.freeVmoney - viewerBefore.freeVmoney, viewerGrants.freeVmoney)
        assert.deepEqual(itemDelta(viewerBefore, viewerAfter), viewerGrants.items)

        // 未参赛玩家 → status 3,无领取记录、无奖励
        const newcomerId = createPlayer("newcomer", 800000297)
        const newcomerReward = await post(fastify, "/receive_reward", {
            viewer_id: 800000297,
            ranking_event_id: 1,
        })
        assert.equal(newcomerReward.statusCode, 200, newcomerReward.body)
        assert.deepEqual(decode(newcomerReward).data, { status: 3 }, "未参赛玩家按官方语义返回 status=3")
        assert.equal(captureClaimState(newcomerId).claimed, 0, "未参赛不得写入领取记录")

        // 原子性:Item 发放被触发器强制失败 → 500,领取记录与全部奖励整体回滚
        const rollbackBefore = captureClaimState(rollbackId)
        db.exec(`
            CREATE TRIGGER force_ranking_claim_failure
            BEFORE INSERT ON players_items
            WHEN NEW.player_id = ${rollbackId}
            BEGIN
                SELECT RAISE(ABORT, 'test forced ranking item failure');
            END;
        `)
        const rollbackResponse = await post(fastify, "/receive_reward", {
            viewer_id: 800000299,
            ranking_event_id: 1,
        })
        db.exec("DROP TRIGGER force_ranking_claim_failure")
        assert.equal(rollbackResponse.statusCode, 500, "发放失败必须以 500 结束")
        assert.deepEqual(captureClaimState(rollbackId), rollbackBefore, "失败事务不得留下领取记录或部分奖励")

        // 复刻活动(event 1000)的 Mana 槽:kind 3 → freeMana
        insertPlayerQuestProgressSync(championId, 11, {
            questId: 1000001,
            finished: true,
            unlocked: true,
            highScore: 5000,
            bestElapsedTimeMs: 8000,
            leaderCharacterId: 341005,
        })
        const revivalBefore = captureClaimState(championId)
        const revivalReward = await post(fastify, "/receive_reward", {
            viewer_id: 800000298,
            ranking_event_id: 1000,
        })
        assert.equal(revivalReward.statusCode, 200, revivalReward.body)
        const revivalData = decode(revivalReward).data
        assert.equal(revivalData.status, 1, "复刻活动首领同样返回 status=1")
        const revivalAfter = captureClaimState(championId)
        assert.equal(
            revivalAfter.freeMana - revivalBefore.freeMana,
            expectedGrantsFromTier(selectTier(1000, 0)).freeMana,
            "复刻活动的 Mana 槽必须发放为 freeMana",
        )

        const rewardUnknownEvent = await post(fastify, "/receive_reward", {
            viewer_id: viewerId,
            ranking_event_id: 999,
        })
        assert.equal(rewardUnknownEvent.statusCode, 200, rewardUnknownEvent.body)
        assert.deepEqual(decode(rewardUnknownEvent).data, { status: 3 }, "未知活动同样按官方无可领语义应答")
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("ranking event route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
