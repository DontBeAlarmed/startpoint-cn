// Degree mission computer (category 5)

import { getPlayerSync } from "../../data/domains/player"
import { getRankDegree } from "../stamina"
import type { MissionComputer, CategoryContext } from "./types"

// Degree mission target lookup
const degreeTargetMap: Record<number, number> = {}
{
    // Note: this import is resolved at module load time via the patterns file's data
    // but we use the same degreeDefs. For simplicity, inline the regex.
    const degreeDefs = require("../../../assets/mission_degree.json")
    const descRegex = /玩家(?:达到|级别达到)\s*(\d+)/
    for (const [mid, rows] of Object.entries(degreeDefs as Record<string, any>)) {
        const row = (rows as any[])[0]
        if (!row || !row[2]) continue
        const match = descRegex.exec(String(row[2]))
        if (match) degreeTargetMap[parseInt(mid)] = parseInt(match[1])
    }
}

export function getTargetDegree(missionId: number): number | undefined {
    return degreeTargetMap[missionId]
}

function buildStats(playerId: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    return {
        playerId,
        player,
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
    }
}

export const DegreeComputer: MissionComputer = {
    name: "Degree",

    buildContext(playerId: number, _category: number): CategoryContext {
        return buildStats(playerId)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const targetDeg = getTargetDegree(missionId)
        if (targetDeg !== undefined)
            return getRankDegree(ctx.player.rankPoint)
        return dbProgress
    },
}
