import type { RewardGrantEntry } from "../reward-grant"
import type { DropScoreRewardId } from "../types"
import type {
    ScoreRewardSelection,
    ScoreRewardSource,
} from "./score-reward-selection-core"

export interface ScoreRewardDropIds {
    readonly drop_score_reward_ids: DropScoreRewardId[]
    readonly drop_rare_reward_ids: DropScoreRewardId[]
}

export function projectScoreRewardDropIds(
    selection: ScoreRewardSelection,
    entries: readonly RewardGrantEntry<ScoreRewardSource>[] = selection.plan.entries,
): ScoreRewardDropIds {
    const common: DropScoreRewardId[] = []
    const rare: DropScoreRewardId[] = []
    for (const entry of entries) {
        const drop = {
            group_id: entry.source.groupId,
            index: entry.source.index,
            number: entry.source.number,
        }
        if (entry.source.kind === "score_common") common.push(drop)
        else rare.push(drop)
    }
    return {
        drop_score_reward_ids: common,
        drop_rare_reward_ids: rare,
    }
}
