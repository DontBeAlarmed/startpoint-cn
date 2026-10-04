// 幂等回填:称号任务的"通关计数"事实从通关归档(players_quest_progress)重建。
//
// 背景:历史通关(种子导入/计数器口径修正前)绕过了结算生产者,导致
//   1) degree_challenge_dungeon_clear_*(摇曳的迷宫 100/500/3000 次)的计数器
//      challenge_dungeon_clear_count 只统计了 section 13,漏掉联合口径的四类
//      (培育道具 6 / 经验玛纳 14 / 深层域+宝物域 13 / 层叠迷宫 20);
//   2) cond23 精确通关计数任务(荒龙/精灵兽/机兵/始龙之眼/联动降临)的进度
//      停留在 0,尽管归档里已有对应通关。
//
// 口径:全部取 MAX(现值, 归档推算值) —— 幂等,可重复执行,永不回退进度。
// 归档行没有通关时间戳,无法区分活动期内/外,按方案B(2026-10-05)两类形态合并计数。
//
// 用法:
//   node tools/backfill_mission_degree_counters.cjs            # 干跑,只打印计划
//   node tools/backfill_mission_degree_counters.cjs --apply    # 实际写入
//   WDFP_DATABASE_DIR=... 可指向副本先行验证

require("ts-node/register/transpile-only")
const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { buildExactDegreeQuestClearRules } = require("../src/lib/mission/degree-battle-facts")

const apply = process.argv.includes("--apply")
const CHALLENGE_DUNGEON_SECTIONS = [6, 14, 13, 20]

initializeDatabase()
const db = getDb()

const playerIds = db.prepare("SELECT id FROM players ORDER BY id").all().map(row => row.id)
const exactRules = buildExactDegreeQuestClearRules()
console.log(`players=${playerIds.length} exactRules=${exactRules.length} mode=${apply ? "APPLY" : "DRY-RUN"}`)

let counterRowsChanged = 0
let counterRowsInserted = 0
let missionRowsChanged = 0
let missionRowsInserted = 0

const upsertCounter = db.prepare(`
    INSERT INTO players_mission_battle_counters (
        player_id, single_play_count, single_clear_count,
        multi_play_count, multi_clear_count,
        multi_host_clear_count, multi_guest_clear_count,
        single_rank_ss_count,
        rank_ss_count, rank_s_count, rank_a_count, rank_b_count,
        challenge_dungeon_clear_count, single_score_max, single_clear_time_min,
        boss_battle_clear_count, skill_use_count
    ) VALUES (
        @player_id, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        @challenge_dungeon_clear_count, 0, 0, 0, 0
    )
    ON CONFLICT(player_id) DO UPDATE SET
        challenge_dungeon_clear_count = MAX(
            challenge_dungeon_clear_count,
            excluded.challenge_dungeon_clear_count
        )
`)
const upsertMissionProgress = db.prepare(`
    INSERT INTO players_category_missions (category, id, progress, player_id)
    VALUES (5, @mission_id, @progress, @player_id)
    ON CONFLICT(category, id, player_id) DO UPDATE SET
        progress = MAX(progress, excluded.progress)
`)

const run = db.transaction(() => {
    const sectionPlaceholders = CHALLENGE_DUNGEON_SECTIONS.map(() => "?").join(",")
    const mazeSumStatement = db.prepare(`
        SELECT COALESCE(SUM(single_clear_count), 0) AS total
        FROM players_quest_progress
        WHERE player_id = ? AND section IN (${sectionPlaceholders})
    `)
    const counterRowStatement = db.prepare(`
        SELECT challenge_dungeon_clear_count FROM players_mission_battle_counters
        WHERE player_id = ?
    `)
    const missionProgressStatement = db.prepare(`
        SELECT progress FROM players_category_missions
        WHERE category = 5 AND id = ? AND player_id = ?
    `)
    const ruleQueries = exactRules.map(rule => {
        const sections = [...new Set(rule.questIdCategories.values())]
        const questIds = [...rule.questIdCategories.keys()]
        const statement = db.prepare(`
            SELECT COALESCE(SUM(single_clear_count + multi_clear_count), 0) AS total
            FROM players_quest_progress
            WHERE player_id = ? AND section IN (${sections.map(() => "?").join(",")})
                AND quest_id IN (${questIds.map(() => "?").join(",")})
        `)
        return { rule, sections, questIds, statement }
    })
    for (const playerId of playerIds) {
        const archiveSum = mazeSumStatement.get(playerId, ...CHALLENGE_DUNGEON_SECTIONS).total
        const counterRow = counterRowStatement.get(playerId)
        const current = counterRow?.challenge_dungeon_clear_count ?? 0
        if (archiveSum > current) {
            if (apply) upsertCounter.run({ player_id: playerId, challenge_dungeon_clear_count: archiveSum })
            if (counterRow === undefined) counterRowsInserted += 1
            else counterRowsChanged += 1
            console.log(`[maze-counter] player=${playerId} ${current} -> ${archiveSum}`)
        }

        for (const { rule, sections, questIds, statement } of ruleQueries) {
            const computed = statement.get(playerId, ...sections, ...questIds).total
            if (computed <= 0) continue
            const existing = missionProgressStatement.get(rule.missionId, playerId)
            const currentProgress = existing?.progress ?? 0
            if (computed > currentProgress) {
                if (apply) upsertMissionProgress.run({
                    mission_id: rule.missionId,
                    progress: computed,
                    player_id: playerId,
                })
                if (existing === undefined) missionRowsInserted += 1
                else missionRowsChanged += 1
                console.log(`[degree] player=${playerId} mission=${rule.missionId} ${currentProgress} -> ${computed}`)
            }
        }
    }
})

let exitCode = 0
try {
    run()
} catch (error) {
    console.error("backfill failed:", error)
    exitCode = 1
} finally {
    restore()
}
console.log(`done: counterRows changed=${counterRowsChanged} inserted=${counterRowsInserted}; `
    + `missionRows changed=${missionRowsChanged} inserted=${missionRowsInserted}`)
process.exitCode = exitCode
