import { incrementPlayerQuestMultiClearSync } from "../../data/domains/quest"
import { recordMissionBattleResultSync } from "../../data/domains/mission_battle_facts"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { trackCharacterClears } from "../quest/finish/character-clear-tracker"
import { trackLeaderPowerflip } from "../quest/finish/leader-powerflip-tracker"
import { trackPartyCoClears } from "../quest/finish/party-co-clear-tracker"
import { trackPowerflip } from "../quest/finish/powerflip-tracker"
import type { FinishContext } from "../quest/finish/types"
import { getServerTime } from "../../utils"
import { recordEventMissionBattleFacts } from "./event-battle-facts"
import { recordPassMissionBattleFacts } from "./pass-battle-facts"
import { recordActiveMissionConditionalBattleFactsSync } from "./active-conditional-battle-facts"
import { recordActiveMissionSpecificBattleFactsSync } from "./active-mission-specific-battle-facts"
import { createActiveBattleFactContext } from "./active-battle-fact-context"
import { getActiveMissionPlan } from "./active-plan"
import { recordDailyMissionBattleFacts } from "./daily-battle-facts"
import {
    getExactDegreeQuestClearMissionIds,
    recordDegreeMissionBattleFacts,
} from "./degree-battle-facts"
import { recordDegreeBattleStatisticsSync } from "./degree-battle-stat-facts"
import { getDegreeMissionIdsForConditionTypes } from "./degree-candidates"
import { recordRegularMissionBattleFactsSync } from "./regular-battle-facts"
import type { MissionSettlementScope } from "./settlement"

export const BATTLE_SETTLEMENT_CATEGORIES = Object.freeze([1, 2, 3, 6, 7, 8, 10])

export const BATTLE_DEGREE_CONDITION_TYPES = Object.freeze([
    1, 4, 5, 8, 14, 15, 16, 17, 19, 20, 21,
    22, 23, 25, 26, 27, 28, 29, 30, 31, 37, 39, 44, 92,
])

export interface MissionBattleFactsResult {
    awakeMissionIds: number[]
    degreeMissionIds: number[]
}

export function buildBattleMissionSettlementScopes(
    affectedCharacterIds: readonly number[],
    contextualDegreeMissionIds?: readonly number[],
): readonly (number | MissionSettlementScope)[] {
    if (contextualDegreeMissionIds === undefined) {
        return [
            1,
            2,
            3,
            {
                category: 5,
                missionIds: getDegreeMissionIdsForConditionTypes(
                    BATTLE_DEGREE_CONDITION_TYPES,
                    affectedCharacterIds,
                ),
            },
            6,
            7,
            8,
            10,
        ]
    }

    const generalMissionIds = getDegreeMissionIdsForConditionTypes(
        BATTLE_DEGREE_CONDITION_TYPES.filter(conditionType => conditionType !== 19 && conditionType !== 23),
        affectedCharacterIds,
    )
    const exactMissionIds = getExactDegreeQuestClearMissionIds()
    const nonExactType23MissionIds = getDegreeMissionIdsForConditionTypes(
        [23],
        affectedCharacterIds,
    ).filter(missionId => !exactMissionIds.includes(missionId))
    const missionIds = [...new Set([
        ...generalMissionIds,
        ...nonExactType23MissionIds,
        ...contextualDegreeMissionIds,
    ])].sort((left, right) => left - right)

    return [
        1,
        2,
        3,
        {
            category: 5,
            missionIds,
        },
        6,
        7,
        8,
        10,
    ]
}

function getSkillUseCount(ctx: FinishContext): number {
    if (!ctx.questAccomplished) return 0
    let total = 0
    for (const zone of ctx.statistics.zones ?? []) {
        const value = zone.use_skill_count
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || value < 0) return 0
        total += value
        if (!Number.isSafeInteger(total)) return 0
    }
    return total
}

export function recordMissionBattleFacts(
    ctx: FinishContext,
    evaluationTime: Date = new Date(getServerTime() * 1000),
): MissionBattleFactsResult {
    recordMissionBattleResultSync(ctx.playerId, {
        isMulti: ctx.isMulti === true,
        questCategory: ctx.questCategory,
        isHost: ctx.isMultiHost,
        accomplished: ctx.questAccomplished,
        clearRank: ctx.clearRank,
        score: ctx.score,
        clearTime: ctx.clearTime,
        skillUseCount: getSkillUseCount(ctx),
    })
    recordPassMissionBattleFacts(ctx, evaluationTime)
    recordRegularMissionBattleFactsSync(ctx)
    if (!ctx.questAccomplished) return { awakeMissionIds: [], degreeMissionIds: [] }
    recordDegreeBattleStatisticsSync(ctx)
    recordDailyMissionBattleFacts(ctx, evaluationTime)
    recordEventMissionBattleFacts(ctx, evaluationTime)
    const degreeMissionIds = recordDegreeMissionBattleFacts({
        playerId: ctx.playerId,
        questCategory: ctx.questCategory,
        questId: ctx.questId,
        questAccomplished: ctx.questAccomplished,
        isMulti: ctx.isMulti,
        isMvp: ctx.statistics.is_mvp === true,
    }, evaluationTime)
    let repository
    try {
        repository = getContentSnapshot().repository
    } catch {
        repository = undefined
    }
    const activeBattleFactContext = createActiveBattleFactContext(
        ctx,
        getActiveMissionPlan(repository),
        repository,
    )
    recordActiveMissionSpecificBattleFactsSync(ctx, activeBattleFactContext)
    recordActiveMissionConditionalBattleFactsSync(ctx, activeBattleFactContext)
    if (ctx.isMulti) {
        incrementPlayerQuestMultiClearSync(ctx.playerId, ctx.questCategory, ctx.questId)
    }
    trackCharacterClears(ctx)
    trackLeaderPowerflip(ctx)
    const awakeMissionIds = trackPartyCoClears(ctx)
    trackPowerflip(ctx)
    return { awakeMissionIds, degreeMissionIds }
}
