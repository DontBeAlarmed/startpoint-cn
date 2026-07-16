// Event mission computer (category 3)
// Uses pre-generated mission_event_quest_map.json for O(1) pattern-to-quest lookup

import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getMissionPattern } from "./patterns"
import questMap from "../../../assets/mission_event_quest_map.json"
import type { MissionComputer, CategoryContext } from "./types"

interface QuestMapping {
    questIds: number[]
    categories: number[]
    countMode: string  // "single" = finished-based, "multi" = multi_clear_count
}

function buildContext(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)

    let totalQuestClears = 0, ssClears = 0, sClears = 0, aClears = 0, bClears = 0, totalStories = 0
    const questProgress: CategoryContext["questProgress"] = {}

    for (const [section, quests] of Object.entries(questProgressRaw)) {
        const list: CategoryContext["questProgress"][string] = []
        for (const qp of quests) {
            list.push({
                questId: qp.questId, finished: qp.finished,
                clearRank: qp.clearRank, bestElapsedTimeMs: qp.bestElapsedTimeMs,
                leaderCharacterId: qp.leaderCharacterId,
                multiClearCount: qp.multiClearCount,
            })
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

    return {
        playerId, category, player, questProgress,
        totalQuestClears, totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
    }
}

export const EventComputer: MissionComputer = {
    name: "Event",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildContext(playerId, category)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const pattern = getMissionPattern(3, missionId)
        if (!pattern) return dbProgress

        const mapping = (questMap as Record<string, QuestMapping>)[pattern]
        if (!mapping) return dbProgress

        const isMulti = mapping.countMode === "multi"

        let count = 0
        for (const cat of mapping.categories) {
            const progress = ctx.questProgress[String(cat)]
            if (!progress) continue
            for (const q of progress) {
                if (!mapping.questIds.includes(q.questId)) continue
                if (isMulti) {
                    count += q.multiClearCount ?? (q.finished ? 1 : 0)
                } else {
                    if (q.finished) count++
                }
            }
        }
        return count
    },
}
