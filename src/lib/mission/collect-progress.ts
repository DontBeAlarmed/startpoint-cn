import { getPlayerCollectedItemTotalsSync } from "../../data/domains/item"
import { getPlayerSync } from "../../data/domains/player"
import { getMissionMasterDefinition } from "./master-data"
import type { CategoryContext, MissionComputer } from "./types"

export function getCollectMissionItemId(missionId: number): number | undefined {
    const rawItemId = getMissionMasterDefinition(4, missionId)?.row[14]
    const itemId = Number(rawItemId)
    return Number.isSafeInteger(itemId) && itemId > 0 ? itemId : undefined
}

export const CollectComputer: MissionComputer = {
    name: "CollectItemEvent",

    buildContext(playerId: number, category: number): CategoryContext {
        const player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during collect mission evaluation.`)
        return {
            category,
            playerId,
            player,
            questProgress: {},
            totalQuestClears: 0,
            totalStories: 0,
            rankCounts: {},
            collectedItemTotals: getPlayerCollectedItemTotalsSync(playerId),
        }
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const itemId = getCollectMissionItemId(missionId)
        if (itemId === undefined) return dbProgress
        return Math.max(dbProgress, ctx.collectedItemTotals?.[String(itemId)] ?? 0)
    },
}
