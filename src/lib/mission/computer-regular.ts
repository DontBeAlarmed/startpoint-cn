// Regular & Daily mission computer (categories 1, 2)

import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { isComputablePattern, getMissionPattern } from "./patterns"
import { getSnapshot } from "./snapshot"
import type { MissionComputer, CategoryContext } from "./types"

function buildStats(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)

    let totalQuestClears = 0, ssClears = 0, sClears = 0, aClears = 0, bClears = 0, totalStories = 0
    const questProgress: CategoryContext["questProgress"] = {}

    for (const [section, quests] of Object.entries(questProgressRaw)) {
        const list: CategoryContext["questProgress"][string] = []
        for (const qp of quests) {
            list.push({ questId: qp.questId, finished: qp.finished, clearRank: qp.clearRank, bestElapsedTimeMs: qp.bestElapsedTimeMs, leaderCharacterId: qp.leaderCharacterId, multiClearCount: qp.multiClearCount })
            if (qp.finished) {
                totalQuestClears++
                if (section === '3') totalStories++
                if (qp.clearRank === 6) ssClears++
                else if (qp.clearRank === 5) sClears++
                else if (qp.clearRank === 4) aClears++
                else if (qp.clearRank === 3) bClears++
            }
        }
        questProgress[section] = list
    }

    // Load periodic snapshot for daily/weekly categories
    let snapshot = null
    if (category === 2) snapshot = getSnapshot(playerId, 'daily')
    if (category === 10) snapshot = getSnapshot(playerId, 'weekly')

    return {
        playerId,
        player,
        questProgress,
        totalQuestClears,
        totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
        snapshot,
    }
}

export const RegularComputer: MissionComputer = {
    name: "Regular",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildStats(playerId, category)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const { snapshot } = ctx
        const baseClears = snapshot ? (ctx.totalQuestClears - snapshot.questClears) : ctx.totalQuestClears
        const baseStamina = snapshot ? ((ctx.player.totalStaminaUsed ?? 0) - snapshot.staminaUsed) : ctx.player.totalStaminaUsed ?? 0

        const categories = [1, 2] // handled by this computer
        for (const cat of categories) {
            const pattern = getMissionPattern(cat, missionId)
            if (pattern && isComputablePattern(pattern)) {
                if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count'))
                    return baseClears
                if (pattern.includes('stamina_use'))
                    return baseStamina
                if (ctx.rankCounts[pattern] !== undefined) {
                    const baseRank = snapshot
                        ? (ctx.rankCounts[pattern] - ((snapshot as any)[rankToSnapshotKey(pattern)] ?? 0))
                        : ctx.rankCounts[pattern]
                    return baseRank
                }
            }
        }
        return dbProgress
    },
}

function rankToSnapshotKey(pattern: string): string {
    if (pattern.includes('rank_ss')) return 'rankSs'
    if (pattern.includes('rank_s')) return 'rankS'
    if (pattern.includes('rank_a')) return 'rankA'
    if (pattern.includes('rank_b')) return 'rankB'
    return ''
}
