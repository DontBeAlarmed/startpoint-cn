import { buildCollectCategoryContextFromSession } from "./collect-session-context"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { MissionMasterDefinition, getMissionCatalog } from "./mission-catalog"
import type { CategoryContext, MissionComputer } from "./types"

export function getCollectMissionItemId(missionId: number): number | undefined {
    const rawItemId = getMissionCatalog().getDefinition(4, missionId)?.row[14]
    return parsePositiveSafeIntegerMasterValue(rawItemId)
}

function buildCollectMissionItemIds(
    missionIds: readonly number[] | undefined,
): ReadonlyMap<number, number> {
    const definitions = missionIds === undefined
        ? getMissionCatalog().getDefinitions(4)
        : missionIds.map(missionId => getMissionCatalog().getDefinition(4, missionId))
            .filter((definition): definition is MissionMasterDefinition => definition !== undefined)
    const itemIds = new Map<number, number>()
    for (const definition of definitions) {
        const itemId = parsePositiveSafeIntegerMasterValue(definition.row[14])
        if (itemId !== undefined) itemIds.set(definition.missionId, itemId)
    }
    return itemIds
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
