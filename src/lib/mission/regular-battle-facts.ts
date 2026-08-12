import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinition } from "./master-data"

const BATTLE_MANA_MISSION_ID = 4
const EXPERT_SINGLE_MISSION_ID = 94

function hasExpectedPattern(missionId: number, pattern: string): boolean {
    return getMissionMasterDefinition(1, missionId)?.pattern === pattern
}

export function recordRegularMissionBattleFactsSync(
    context: Pick<FinishContext,
        "playerId" | "questCategory" | "questAccomplished" | "isMulti" | "manaObtained">,
): void {
    const manaObtained = context.manaObtained ?? 0
    if (Number.isSafeInteger(manaObtained)
        && manaObtained > 0
        && hasExpectedPattern(BATTLE_MANA_MISSION_ID, "total_attained_drop_mana_count")) {
        incrementPlayerCategoryMissionSync(
            context.playerId,
            1,
            BATTLE_MANA_MISSION_ID,
            manaObtained,
        )
    }

    if (context.questAccomplished
        && context.isMulti !== true
        && context.questCategory === 21
        && hasExpectedPattern(EXPERT_SINGLE_MISSION_ID, "challenge_single_battle_play")) {
        incrementPlayerCategoryMissionSync(context.playerId, 1, EXPERT_SINGLE_MISSION_ID, 1)
    }
}
