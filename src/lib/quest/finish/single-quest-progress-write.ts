import {
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../../data/domains/quest"
import type { PlayerQuestProgress } from "../../../data/types"
import {
    createBattleQuestProgressPlan,
    type BattleQuestProgressPlanInput,
} from "./battle-quest-progress-plan"

export interface SingleQuestProgressWriteInput extends Omit<
    BattleQuestProgressPlanInput,
    "missingLeader"
> {
    readonly playerId: number
    readonly questCategory: number
}

/** Executes a shared progress plan inside the Single adapter's existing transaction. */
export function writeSingleQuestProgressWithinTransactionSync(
    input: SingleQuestProgressWriteInput,
): boolean {
    const plan = createBattleQuestProgressPlan({ ...input, missingLeader: "preserve" })
    if (plan.kind === "none") return false
    const values: PlayerQuestProgress = {
        ...plan.values,
        leaderCharacterId: plan.values.leaderCharacterId ?? undefined,
    }
    if (plan.kind === "update") {
        updatePlayerQuestProgressSync(input.playerId, input.questCategory, values)
    } else {
        insertPlayerQuestProgressSync(input.playerId, input.questCategory, values)
    }
    return true
}
