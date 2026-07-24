import {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
} from "./master-data"
import { RegularComputer } from "./computer-regular"
import type { CategoryContext, MissionComputer } from "./types"
import { ensurePlayerPassCardLoginProgressSync } from "../../data/domains/pass-card"
import { buildPeriodicSnapshotData, getPassWeekSnapshotType, getSnapshot, takeSnapshot } from "./snapshot"

function periodValue(current: number, baseline: number | undefined): number {
    return Math.max(0, current - (baseline ?? 0))
}

function computePeriodicPassProgress(
    patternType: number | undefined,
    context: CategoryContext,
    dbProgress: number,
): number {
    const counters = context.battleCounters
    const snapshot = context.snapshot
    if (!counters) return dbProgress

    switch (patternType) {
        case 14:
            return Math.max(dbProgress, periodValue(counters.singleClearCount, snapshot?.singleClearCount))
        case 16:
            return Math.max(dbProgress, periodValue(counters.multiClearCount, snapshot?.multiClearCount))
        case 28:
            return Math.max(dbProgress, periodValue(context.player.totalDashes ?? 0, snapshot?.dashCount))
        case 39:
            return Math.max(dbProgress, periodValue(context.player.totalStaminaUsed ?? 0, snapshot?.staminaUsed))
        default:
            return dbProgress
    }
}

export const PassComputer: MissionComputer = {
    name: "Pass",

    buildContext(playerId: number, category: number, evaluationTime: Date): CategoryContext {
        const context = RegularComputer.buildContext(playerId, category, evaluationTime)
        if (category === 7) {
            const eventId = getMissionMasterDefinitions(7).find(definition =>
                definition.eventId !== undefined
                && isMissionDefinitionEnabledAt(definition, evaluationTime)
            )?.eventId
            if (eventId === undefined) return context
            const snapshotType = getPassWeekSnapshotType(eventId)
            let snapshot = getSnapshot(playerId, snapshotType)
            if (!snapshot) {
                snapshot = buildPeriodicSnapshotData(
                    playerId,
                    context.player,
                    context.totalQuestClears,
                )
                takeSnapshot(playerId, snapshotType, snapshot)
            }
            context.snapshot = snapshot
            return context
        }
        if (category !== 8) return context

        const loginProgress: Record<number, number> = {}
        for (const definition of getMissionMasterDefinitions(8)) {
            if (definition.patternType !== 0
                || definition.eventId === undefined
                || !isMissionDefinitionEnabledAt(definition, evaluationTime)) continue
            loginProgress[definition.missionId] = ensurePlayerPassCardLoginProgressSync(
                playerId,
                definition.eventId,
                context.player.totalLoginDays ?? 0,
            )
        }
        context.passEventLoginProgress = loginProgress
        return context
    },

    compute(missionId: number, context: CategoryContext, dbProgress: number): number {
        const definition = getMissionMasterDefinition(context.category, missionId)
        if (!definition) return dbProgress

        if (context.category === 6 || context.category === 7) {
            return computePeriodicPassProgress(definition.patternType, context, dbProgress)
        }
        if (context.category === 8 && definition.patternType === 0) {
            return Math.max(dbProgress, context.passEventLoginProgress?.[missionId] ?? 0)
        }
        return dbProgress
    },
}
