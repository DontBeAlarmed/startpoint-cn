// Fallback computer — returns DB-stored progress for unhandled categories

import { getPlayerSync } from "../../data/domains/player"
import type { MissionComputer, CategoryContext } from "./types"

function buildMinimal(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    return {
        playerId,
        category,
        player,
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
    }
}

export const FallbackComputer: MissionComputer = {
    name: "Fallback",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildMinimal(playerId, category)
    },

    compute(_missionId: number, _ctx: CategoryContext, dbProgress: number): number {
        return dbProgress
    },
}
