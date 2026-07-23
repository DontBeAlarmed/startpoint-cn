import { incrementPlayerQuestMultiClearSync } from "../../data/domains/quest"
import { trackCharacterClears } from "../quest/finish/character-clear-tracker"
import { trackLeaderPowerflip } from "../quest/finish/leader-powerflip-tracker"
import { trackPartyCoClears } from "../quest/finish/party-co-clear-tracker"
import { trackPowerflip } from "../quest/finish/powerflip-tracker"
import type { FinishContext } from "../quest/finish/types"

export function recordMissionBattleFacts(ctx: FinishContext): void {
    if (!ctx.questAccomplished) return
    if (ctx.isMulti) {
        incrementPlayerQuestMultiClearSync(ctx.playerId, ctx.questCategory, ctx.questId)
    }
    trackCharacterClears(ctx)
    trackLeaderPowerflip(ctx)
    trackPartyCoClears(ctx)
    trackPowerflip(ctx)
}
