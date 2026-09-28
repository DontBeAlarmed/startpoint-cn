import type {
    RewardGrantExecutionResult,
} from "./execution-contract"
import type { PlannedItemOverflowDisposition } from "../item-overflow/disposition"

export type { RewardGrantExecutionResult } from "./execution-contract"

export function collectRewardGrantItemOverflowDispositions(
    result: RewardGrantExecutionResult,
): readonly PlannedItemOverflowDisposition[] {
    const dispositions: PlannedItemOverflowDisposition[] = []
    for (const entry of result.entries) {
        const outcome = entry.outcome
        const item = outcome.kind === "item"
            ? outcome.item
            : outcome.kind === "character"
                ? outcome.compensationItem
                : null
        if (item !== null) dispositions.push(...(item.overflowDispositions ?? []))
    }
    return Object.freeze(dispositions)
}
