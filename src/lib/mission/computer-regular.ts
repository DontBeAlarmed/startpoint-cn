import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getDegreeBattleStatsSync } from "../../data/domains/degree_battle_stats"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getRankDegree } from "../stamina"
import { getMissionPattern } from "./patterns"
import { getMissionMasterDefinitions } from "./master-data"
import {
    computeRegularQuestProgress,
    isRegularQuestMissionSupported,
} from "./regular-quest-facts"
import { getRegularStateFactsSync } from "./regular-state-facts"
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
    let exRankSsCount = 0
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
            if (section === "4" && qp.clearRank === 5) exRankSsCount++
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
        ...(category === 1 ? {
            regularStats: {
                exRankSsCount,
                degreeBattleStats: getDegreeBattleStatsSync(playerId),
                state: getRegularStateFactsSync(playerId),
            },
        } : {}),
        battleCounters: getMissionBattleCountersSync(playerId),
        snapshot,
    }
}

function periodValue(current: number, baseline: number | undefined): number {
    return Math.max(0, current - (baseline ?? 0))
}

const LIFETIME_PATTERNS = new Set([
    "max_combo", "rank_ss", "use_dash", "single_battle_play", "use_power_flip",
    "user_rank", "total_login", "multi_battle_play", "multi_play_host", "multi_play_guest",
    "use_skill", "character_level", "clear_episode", "weak_point_attack", "max_skill_chain",
    "max_power_achievement", "fever", "max_score", "enemy_kill", "ex_rank_ss",
    "characters_count", "got_equip_kind_count", "character_80_level",
    "total_released_mana_node_count", "over_limit_total_count",
    "total_obtained_bond_token_count", "total_mana_addition_count",
    "treasure_shop_used_mana_count", "total_craft_point_addition_count",
    "total_equipment_awaking_count", "total_equipment_5_level_count",
    "manaboard_2nd_open_count", "manaboard_2nd_complete_count",
    "total_attained_drop_mana_count", "challenge_single_battle_play",
    "total_ability_soul_use_count", "get_mvp",
])

export function getRegularComputedMissionIds(): readonly number[] {
    return Object.freeze(getMissionMasterDefinitions(1)
        .filter(definition => LIFETIME_PATTERNS.has(definition.pattern)
            || isRegularQuestMissionSupported(definition.missionId))
        .map(definition => definition.missionId)
        .sort((left, right) => left - right))
}

function computeLifetime(pattern: string, ctx: CategoryContext, dbProgress: number): number {
    const counters = ctx.battleCounters!
    const regularStats = ctx.regularStats!
    const battleStats = regularStats.degreeBattleStats
    const state = regularStats.state
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
    if (pattern === "use_skill") return Math.max(dbProgress, counters.skillUseCount)
    if (pattern === "character_level") return Math.max(dbProgress, getRankDegree(ctx.player.rankPoint))
    if (pattern === "clear_episode") return Math.max(dbProgress, ctx.totalStories)
    if (pattern === "weak_point_attack") return Math.max(dbProgress, battleStats.weakPointAttackCount)
    if (pattern === "max_skill_chain") return Math.max(dbProgress, battleStats.skillChainMax)
    if (pattern === "max_power_achievement") return Math.max(dbProgress, battleStats.partyPowerMax)
    if (pattern === "fever") return Math.max(dbProgress, battleStats.feverCount)
    if (pattern === "max_score") return Math.max(dbProgress, counters.singleScoreMax)
    if (pattern === "enemy_kill") return Math.max(dbProgress, battleStats.enemyKillCount)
    if (pattern === "ex_rank_ss") return Math.max(dbProgress, regularStats.exRankSsCount)
    if (pattern === "characters_count") return Math.max(dbProgress, state.characterCount)
    if (pattern === "got_equip_kind_count") return Math.max(dbProgress, state.equipmentKindCount)
    if (pattern === "character_80_level") return Math.max(dbProgress, state.level80CharacterCount)
    if (pattern === "total_released_mana_node_count") return Math.max(dbProgress, state.manaBoardNodeCount)
    if (pattern === "over_limit_total_count") return Math.max(dbProgress, state.overLimitCount)
    if (pattern === "total_obtained_bond_token_count") return Math.max(dbProgress, state.bondTokenCount)
    if (pattern === "total_mana_addition_count") return Math.max(dbProgress, ctx.player.totalManaObtained ?? 0)
    if (pattern === "total_craft_point_addition_count") {
        return Math.max(dbProgress, state.craftPointObtainedCount)
    }
    if (pattern === "total_equipment_awaking_count") {
        return Math.max(dbProgress, state.equipmentAwakeningCount)
    }
    if (pattern === "total_equipment_5_level_count") {
        return Math.max(dbProgress, state.maxLevelEquipmentCount)
    }
    if (pattern === "manaboard_2nd_open_count") {
        return Math.max(dbProgress, state.secondManaBoardOpenCount)
    }
    if (pattern === "manaboard_2nd_complete_count") {
        return Math.max(dbProgress, state.secondManaBoardCompleteCount)
    }
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
        if (ctx.category === 1) {
            const questProgress = computeRegularQuestProgress(missionId, ctx)
            if (questProgress !== undefined) return Math.max(dbProgress, questProgress)
            return computeLifetime(pattern, ctx, dbProgress)
        }
        if (ctx.category === 2) return computeDaily(pattern, ctx, dbProgress)
        if (ctx.category === 10) return computeWeekly(pattern, ctx, dbProgress)
        return dbProgress
    },
}
