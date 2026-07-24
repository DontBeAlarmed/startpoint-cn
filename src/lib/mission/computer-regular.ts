import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getRankDegree } from "../stamina"
import { getMissionPattern } from "./patterns"
import { getSnapshot } from "./snapshot"
import type { MissionComputer, CategoryContext } from "./types"

function buildStats(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)

    let totalQuestClears = 0
    let totalStories = 0
    let ssClears = 0
    let sClears = 0
    let aClears = 0
    let bClears = 0
    const questProgress: CategoryContext["questProgress"] = {}

    for (const [section, quests] of Object.entries(questProgressRaw)) {
        const list: CategoryContext["questProgress"][string] = []
        for (const qp of quests) {
            list.push({
                questId: qp.questId,
                finished: qp.finished,
                clearRank: qp.clearRank,
                bestElapsedTimeMs: qp.bestElapsedTimeMs,
                leaderCharacterId: qp.leaderCharacterId,
                multiClearCount: qp.multiClearCount,
            })
            if (!qp.finished) continue
            totalQuestClears++
            if (section === "3") totalStories++
            if (qp.clearRank === 5) ssClears++
            else if (qp.clearRank === 4) sClears++
            else if (qp.clearRank === 3) aClears++
            else if (qp.clearRank === 2) bClears++
        }
        questProgress[section] = list
    }

    const snapshot = category === 2 || category === 6
        ? getSnapshot(playerId, "daily")
        : category === 7 || category === 10
            ? getSnapshot(playerId, "weekly")
            : null

    return {
        category,
        playerId,
        player,
        questProgress,
        totalQuestClears,
        totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
        battleCounters: getMissionBattleCountersSync(playerId),
        snapshot,
    }
}

function periodValue(current: number, baseline: number | undefined): number {
    return Math.max(0, current - (baseline ?? 0))
}

function computeLifetime(pattern: string, ctx: CategoryContext, dbProgress: number): number {
    const counters = ctx.battleCounters!
    if (pattern === "max_combo") return Math.max(dbProgress, ctx.player.maxComboAchieved ?? 0)
    if (pattern === "rank_ss") return Math.max(dbProgress, counters.rankSsCount)
    if (pattern === "use_dash") return Math.max(dbProgress, ctx.player.totalDashes ?? 0)
    if (pattern === "single_battle_play") return Math.max(dbProgress, counters.singleClearCount)
    if (pattern === "use_power_flip") return Math.max(dbProgress, ctx.player.totalPowerflips ?? 0)
    if (pattern === "user_rank") return Math.max(dbProgress, getRankDegree(ctx.player.rankPoint))
    if (pattern === "total_login") return Math.max(dbProgress, ctx.player.totalLoginDays ?? 0)
    if (pattern === "multi_battle_play") return Math.max(dbProgress, counters.multiClearCount)
    if (pattern === "multi_play_host") return Math.max(dbProgress, counters.multiHostClearCount)
    if (pattern === "multi_play_guest") return Math.max(dbProgress, counters.multiGuestClearCount)
    return dbProgress
}

function computeDaily(pattern: string, ctx: CategoryContext, dbProgress: number): number {
    const snapshot = ctx.snapshot
    const counters = ctx.battleCounters!
    if (/^single_battle_play(?:_[23])?$/.test(pattern)) {
        return Math.max(dbProgress, periodValue(counters.singleClearCount, snapshot?.singleClearCount))
    }
    if (/^multi_battle_play(?:_[23])?$/.test(pattern)) {
        return Math.max(dbProgress, periodValue(counters.multiClearCount, snapshot?.multiClearCount))
    }
    if (/^use_dash(?:_[23])?$/.test(pattern)) {
        return Math.max(dbProgress, periodValue(ctx.player.totalDashes ?? 0, snapshot?.dashCount))
    }
    if (pattern === "daily_quest_stamina_use_2024_02") {
        return Math.max(dbProgress, periodValue(ctx.player.totalStaminaUsed ?? 0, snapshot?.staminaUsed))
    }
    return dbProgress
}

function computeWeekly(pattern: string, ctx: CategoryContext, dbProgress: number): number {
    const snapshot = ctx.snapshot
    const counters = ctx.battleCounters!
    if (pattern === "weekly_mission_1") {
        return Math.max(dbProgress, periodValue(ctx.player.totalLoginDays ?? 0, snapshot?.loginDays))
    }
    if (pattern === "weekly_mission_2") {
        return Math.max(dbProgress, periodValue(counters.multiClearCount, snapshot?.multiClearCount))
    }
    return dbProgress
}

export const RegularComputer: MissionComputer = {
    name: "Regular",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildStats(playerId, category)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const pattern = getMissionPattern(ctx.category, missionId)
        if (ctx.category === 1) return computeLifetime(pattern, ctx, dbProgress)
        if (ctx.category === 2) return computeDaily(pattern, ctx, dbProgress)
        if (ctx.category === 10) return computeWeekly(pattern, ctx, dbProgress)
        return dbProgress
    },
}
