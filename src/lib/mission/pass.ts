import {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
} from "./master-data"
import { RegularComputer } from "./computer-regular"
import type { CategoryContext, MissionComputer } from "./types"
import { ensurePlayerPassCardLoginProgressSync } from "../../data/domains/pass-card"
import { buildPeriodicSnapshotData, getPassWeekSnapshotType, getSnapshot, takeSnapshot } from "./snapshot"
import { buildPeriodicCategoryContextFromSession } from "./periodic-session-context"
import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import type { MissionEvaluationSession } from "./evaluation-session"

function periodValue(current: number, baseline: number | undefined): number {
    return Math.max(0, current - (baseline ?? 0))
}

function computePeriodicPassProgress(
    patternType: number | undefined,
    context: CategoryContext,
    dbProgress: number,
): number {
    const snapshot = context.snapshot

    switch (patternType) {
        case 14: {
            const counters = context.battleCounters
            if (!counters) return dbProgress
            return Math.max(
                dbProgress,
                periodValue(counters.singleClearCount, snapshot?.singleClearCount),
            )
        }
        case 16: {
            const counters = context.battleCounters
            if (!counters) return dbProgress
            return Math.max(
                dbProgress,
                periodValue(counters.multiClearCount, snapshot?.multiClearCount),
            )
        }
        case 28:
            return Math.max(dbProgress, periodValue(context.player.totalDashes ?? 0, snapshot?.dashCount))
        case 39:
            return Math.max(dbProgress, periodValue(context.player.totalStaminaUsed ?? 0, snapshot?.staminaUsed))
        default:
            return dbProgress
    }
}

function emptyPassContext(session: MissionEvaluationSession, category: number): CategoryContext {
    return {
        category,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: { rank_ss: 0, rank_s: 0, rank_a: 0, rank_b: 0 },
    }
}

function buildWeeklyPassContext(
    session: MissionEvaluationSession,
    missionIds: readonly number[],
): CategoryContext {
    const plan = buildCategoryFactPlan(session, 7, missionIds)
    const context = emptyPassContext(session, 7)
    const battleKey = getFactLoadPlanKey(plan, "missionBattleCounters")
    const snapshotKey = getFactLoadPlanKey(plan, "periodicSnapshot")
    return {
        ...context,
        ...(battleKey ? { battleCounters: session.getFactFromPlan(battleKey, plan) } : {}),
        ...(snapshotKey ? { snapshot: session.getFactFromPlan(snapshotKey, plan) } : {}),
    }
}

function buildEventPassContext(
    session: MissionEvaluationSession,
    missionIds: readonly number[],
): CategoryContext {
    const context = emptyPassContext(session, 8)
    const loginProgress: Record<number, number> = {}
    for (const missionId of missionIds) {
        const definition = getMissionMasterDefinition(8, missionId)
        if (definition?.patternType !== 0 || definition.eventId === undefined) continue
        const state = session.getFact({ kind: "passState", eventId: definition.eventId })
        loginProgress[missionId] = state.loginBaseline === undefined
            ? 0
            : Math.max(0, context.player.totalLoginDays - state.loginBaseline)
    }
    return { ...context, passEventLoginProgress: loginProgress }
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

    buildContextFromSession(session, category, missionIds): CategoryContext {
        if (category === 6) {
            return buildPeriodicCategoryContextFromSession(session, category, missionIds, "daily")
        }
        if (category === 7) return buildWeeklyPassContext(session, missionIds)
        if (category === 8) return buildEventPassContext(session, missionIds)
        throw new Error("Pass Session context only supports categories 6, 7 and 8")
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
