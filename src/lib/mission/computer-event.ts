// Event mission computer (category 3)
// Uses pre-generated mission_event_quest_map.json for O(1) pattern→quest lookup

import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getMissionPattern } from "./patterns"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"
import questMap from "../../../assets/mission_event_quest_map.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import type { MissionComputer, CategoryContext } from "./types"
import { getSafeEventBattleRuleCoverage } from "./event-battle-facts"

type EventCountMode = "single" | "multi" | "finish"

interface QuestMapping {
    questIds: number[]
    categories: number[]
    countMode: EventCountMode
}

export interface EventMissionCoverageReport {
    total: number
    mapped: number
    safeAutoSettlement: number
    unsupported: number
    activeUnsupported: number
    countModes: Record<EventCountMode, number>
    unsupportedPatterns: string[]
}

function getTargetClearTimeMs(missionId: number): number | undefined {
    const stages = (eventRewards as Record<string, Record<string, unknown[]>>)[String(missionId)]
    const firstStage = stages && Object.values(stages)[0]
    const row = Array.isArray(firstStage) && Array.isArray(firstStage[0]) ? firstStage[0] : undefined
    const seconds = Number(row?.[2])
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export function getEventMissionCoverageReport(at: Date): EventMissionCoverageReport {
    const definitions = getMissionMasterDefinitions(3)
    const mappings = questMap as Record<string, QuestMapping>
    const unsupportedDefinitions = definitions.filter(definition => mappings[definition.pattern] === undefined)
    const countModes: Record<EventCountMode, number> = { single: 0, multi: 0, finish: 0 }
    for (const definition of definitions) {
        const mapping = mappings[definition.pattern]
        if (mapping) countModes[mapping.countMode]++
    }
    return {
        total: definitions.length,
        mapped: definitions.length - unsupportedDefinitions.length,
        safeAutoSettlement: getSafeEventBattleRuleCoverage().safeMultiClearRules,
        unsupported: unsupportedDefinitions.length,
        activeUnsupported: unsupportedDefinitions.filter(definition =>
            isMissionDefinitionEnabledAt(definition, at)
        ).length,
        countModes,
        unsupportedPatterns: unsupportedDefinitions.map(definition => definition.pattern),
    }
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
                if (qp.clearRank === 5) ssClears++
                else if (qp.clearRank === 4) sClears++
                else if (qp.clearRank === 3) aClears++
                else if (qp.clearRank === 2) bClears++
            }
        }
        questProgress[section] = list
    }

    return {
        category,
        playerId, player, questProgress,
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

        const targetClearTimeMs = mapping.countMode === "finish"
            ? getTargetClearTimeMs(missionId)
            : undefined
        if (mapping.countMode === "finish" && targetClearTimeMs === undefined) return dbProgress

        let count = 0
        for (const cat of mapping.categories) {
            const progress = ctx.questProgress[String(cat)]
            if (!progress) continue
            for (const q of progress) {
                if (!mapping.questIds.includes(q.questId)) continue
                if (mapping.countMode === "multi") {
                    count += q.multiClearCount ?? (q.finished ? 1 : 0)
                } else if (mapping.countMode === "finish") {
                    if (q.finished
                        && q.bestElapsedTimeMs !== undefined
                        && q.bestElapsedTimeMs <= targetClearTimeMs!) count++
                } else if (q.finished) {
                    count++
                }
            }
        }
        return count
    },
}
