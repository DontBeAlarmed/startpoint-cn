import { buildCollectCategoryContextFromSession } from "./collect-session-context"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { getMissionCatalog } from "./mission-catalog"
import { getCollectCurrentStateShape } from "./collect-current-state"
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
        if (itemId !== undefined) {
            return Math.max(dbProgress, ctx.collectedItemTotals?.[String(itemId)] ?? 0)
        }
        // Current-state shapes: the derived state is a safe lower bound.
        const shape = getCollectCurrentStateShape(
            Number(getMissionCatalog().getDefinition(4, missionId)?.row[4]),
        )
        if (shape === undefined || ctx.eventCurrentState === undefined) return dbProgress
        if (shape.fact === "hasEquippedAbilitySoul") {
            return typeof ctx.eventCurrentState.hasEquippedAbilitySoul === "boolean"
                ? Math.max(dbProgress, ctx.eventCurrentState.hasEquippedAbilitySoul ? 1 : 0)
                : dbProgress
        }
        const progress = ctx.eventCurrentState[shape.fact]
        return typeof progress === "number"
            && Number.isSafeInteger(progress) && progress >= 0
            ? Math.max(dbProgress, progress)
            : dbProgress
    },
}
