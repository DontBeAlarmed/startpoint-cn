import { buildCollectCategoryContextFromSession } from "./collect-session-context"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { getMissionCatalog } from "./mission-catalog"
import type { CategoryContext, MissionComputer } from "./types"

export function getCollectMissionItemId(missionId: number): number | undefined {
    const rawItemId = getMissionCatalog().getDefinition(4, missionId)?.row[14]
    return parsePositiveSafeIntegerMasterValue(rawItemId)
}

export const CollectComputer: MissionComputer = {
    name: "CollectItemEvent",

    buildContextFromSession(session, category, missionIds): CategoryContext {
        if (category !== 4) {
            throw new Error("Collect Session context only supports category 4")
        }
        return buildCollectCategoryContextFromSession(session, missionIds)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const itemId = ctx.collectMissionItemIds?.get(missionId)
        if (itemId === undefined) return dbProgress
        return Math.max(dbProgress, ctx.collectedItemTotals?.[String(itemId)] ?? 0)
    },
}
