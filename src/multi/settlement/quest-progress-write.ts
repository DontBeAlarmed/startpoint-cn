import {
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
    type PlayerQuestProgressWrite,
} from "../../data/domains/quest"
import {
    createBattleQuestProgressPlan,
    type BattleQuestProgressPlanInput,
} from "../../lib/quest/finish/battle-quest-progress-plan"

export interface MultiQuestProgressWriteInput extends Omit<
    BattleQuestProgressPlanInput,
    "missingLeader"
> {
    readonly playerId: number
    readonly questCategory: number
}

/** Executes a shared progress plan inside the Multi adapter's existing transaction. */
export function writeMultiQuestProgressWithinTransactionSync(
    input: MultiQuestProgressWriteInput,
): boolean {
    const plan = createBattleQuestProgressPlan({ ...input, missingLeader: "clear" })
    if (plan.kind === "none") return false
    const values: PlayerQuestProgressWrite = plan.values
    if (plan.kind === "update") {
        updatePlayerQuestProgressSync(input.playerId, input.questCategory, values)
    } else {
        insertPlayerQuestProgressSync(input.playerId, input.questCategory, values)
    }
    return true
}
