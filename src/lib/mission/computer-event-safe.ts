import { getPlayerCollectedItemTotalsSync } from "../../data/domains/item"
import { getPlayerSync } from "../../data/domains/player"
import { getMissionMasterDefinition } from "./master-data"
import type { CategoryContext, MissionComputer } from "./types"

const GET_ITEM_COUNT_PATTERN_TYPE = 37

export function getEventItemMissionItemId(missionId: number): number | undefined {
    const row = getMissionMasterDefinition(3, missionId)?.row
    if (!row || Number(row[2]) !== GET_ITEM_COUNT_PATTERN_TYPE) return undefined
    const itemId = Number(row[12])
    return Number.isSafeInteger(itemId) && itemId > 0 ? itemId : undefined
}

export const EventSafeComputer: MissionComputer = {
    name: "EventSafe",

    buildContext(playerId: number, category: number): CategoryContext {
        const player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during event mission evaluation.`)
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
        const itemId = getEventItemMissionItemId(missionId)
        if (itemId === undefined) return dbProgress
        return Math.max(dbProgress, ctx.collectedItemTotals?.[String(itemId)] ?? 0)
    },
}
