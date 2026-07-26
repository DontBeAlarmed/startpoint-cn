import { incrementPlayerQuestMultiClearSync } from "../../data/domains/quest"
import { recordMissionBattleResultSync } from "../../data/domains/mission_battle_facts"
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
import { recordDailyMissionBattleFacts } from "./daily-battle-facts"
import { recordDegreeMissionBattleFacts } from "./degree-battle-facts"
import { recordDegreeBattleStatisticsSync } from "./degree-battle-stat-facts"

export const BATTLE_SETTLEMENT_CATEGORIES = Object.freeze([1, 2, 3, 6, 7, 8, 10])

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
): void {
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
    if (!ctx.questAccomplished) return
    recordDegreeBattleStatisticsSync(ctx)
    recordDailyMissionBattleFacts(ctx, evaluationTime)
    recordEventMissionBattleFacts(ctx, evaluationTime)
    recordDegreeMissionBattleFacts(ctx, evaluationTime)
    recordPassMissionBattleFacts(ctx, evaluationTime)
    recordActiveMissionSpecificBattleFactsSync(ctx)
    recordActiveMissionConditionalBattleFactsSync(ctx)
    if (ctx.isMulti) {
        incrementPlayerQuestMultiClearSync(ctx.playerId, ctx.questCategory, ctx.questId)
    }
    trackCharacterClears(ctx)
    trackLeaderPowerflip(ctx)
    trackPartyCoClears(ctx)
    trackPowerflip(ctx)
}
