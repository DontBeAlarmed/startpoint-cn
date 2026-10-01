import {
    incrementPlayerQuestSingleClearSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
    type PlayerQuestProgressWrite,
} from "../../../data/domains/quest"
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
    const values: PlayerQuestProgressWrite = {
        ...plan.values,
        leaderCharacterId: plan.values.leaderCharacterId ?? undefined,
    }
    if (plan.kind === "update") {
        updatePlayerQuestProgressSync(input.playerId, input.questCategory, values)
    } else {
        insertPlayerQuestProgressSync(input.playerId, input.questCategory, values)
    }
    // The plan is "none" unless the quest was accomplished, so a written
    // finish is exactly one archived single clear — the recomputable fact
    // that mirrors multi_clear_count for single-player repeats.
    incrementPlayerQuestSingleClearSync(input.playerId, input.questCategory, input.questId)
    return true
}
