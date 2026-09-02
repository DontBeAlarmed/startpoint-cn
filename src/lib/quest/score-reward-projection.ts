import type { DropScoreRewardId } from "../types"
import { RewardType } from "../types"
import { rewardGrantFingerprint } from "../reward-grant"
import type { ScoreRewardSelection } from "./score-reward-selection-core"

export interface ScoreRewardDropIds {
    readonly drop_score_reward_ids: DropScoreRewardId[]
    readonly drop_rare_reward_ids: DropScoreRewardId[]
}

export class ScoreRewardSelectionMismatchError extends Error {
    constructor(readonly entryIndex: number) {
        super(`Score reward metadata does not match grant entry ${entryIndex}`)
        this.name = "ScoreRewardSelectionMismatchError"
    }
}

export function validateScoreRewardSelection(selection: ScoreRewardSelection): void {
    if (selection.dropMetadata.length !== selection.plan.entries.length) {
        throw new ScoreRewardSelectionMismatchError(-1)
    }
    for (let index = 0; index < selection.dropMetadata.length; index += 1) {
        const metadata = selection.dropMetadata[index]
        const command = selection.plan.entries[index]
        const commandCount = command.type === RewardType.CHARACTER ? 1 : command.count
        if (metadata.entryIndex !== index
            || metadata.number !== commandCount
            || metadata.rewardFingerprint
                !== rewardGrantFingerprint(command)) {
            throw new ScoreRewardSelectionMismatchError(index)
        }
    }
}

export function projectScoreRewardDropIds(
    selection: ScoreRewardSelection,
): ScoreRewardDropIds {
    validateScoreRewardSelection(selection)
    const common: DropScoreRewardId[] = []
    const rare: DropScoreRewardId[] = []
    for (const entry of selection.dropMetadata) {
        const drop = {
            group_id: entry.groupId,
            index: entry.dropIndex,
            number: entry.number,
        }
        if (entry.kind === "score_common") common.push(drop)
        else rare.push(drop)
    }
    return {
        drop_score_reward_ids: common,
        drop_rare_reward_ids: rare,
    }
}
