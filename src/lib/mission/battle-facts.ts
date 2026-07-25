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

export const BATTLE_SETTLEMENT_CATEGORIES = Object.freeze([1, 2, 3, 6, 7, 8, 10])

export function recordMissionBattleFacts(
    ctx: FinishContext,
    evaluationTime: Date = new Date(getServerTime() * 1000),
): void {
    recordMissionBattleResultSync(ctx.playerId, {
        isMulti: ctx.isMulti === true,
        isHost: ctx.isMultiHost,
        accomplished: ctx.questAccomplished,
        clearRank: ctx.clearRank,
    })
    if (!ctx.questAccomplished) return
    recordDailyMissionBattleFacts(ctx, evaluationTime)
    recordEventMissionBattleFacts(ctx, evaluationTime)
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
