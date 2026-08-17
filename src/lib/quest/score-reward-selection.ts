import bundledRewardElementMap from "../../../assets/reward_element_map.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"
import { getDateFromServerTime, getServerTime } from "../../utils"
import { getRareScoreRewardGroup } from "../assets"
import { resolveEventCurrencyId } from "../event-currency"
import { createRewardGrantPlan } from "../reward-grant"
import type { RewardCampaignRates } from "../reward-campaign"
import type { UnitRandom } from "../score-reward-lottery"
import type { ScoreReward } from "../types"
import {
    selectScoreRewardGrantPlanCore,
    type ScoreRewardSelection,
} from "./score-reward-selection-core"

export * from "./score-reward-selection-core"

const ELEMENT_TO_ENEMY_MAP: Readonly<Record<number, number>> = {
    0: 3, 1: 0, 2: 1, 3: 2, 4: 5, 5: 4,
}

export interface ScoreRewardSelectionOptions {
    readonly commonRewardCount?: number
    readonly random?: UnitRandom
    readonly rewardCampaignRates?: RewardCampaignRates
    readonly rewardDate?: Date
}

function resolveContextualItemId(
    kind: "element" | "aether",
    rarity: number,
    questElement?: number,
): number {
    const enemyElement = ELEMENT_TO_ENEMY_MAP[questElement ?? 0] ?? 3
    const map = getRuntimeContentTableSync(
        "reward_element_map.json",
        bundledRewardElementMap as Record<string, Record<string, Record<string, string[][]>>>,
    )
    const mapKind = kind === "element" ? "1" : "2"
    return Number(map[mapKind][String(rarity)][String(enemyElement)][0][0])
}

export function selectScoreRewardGrantPlan(
    groupId?: number,
    scoreRewards?: readonly ScoreReward[],
    boostPointUsed = false,
    questElement?: number,
    options?: ScoreRewardSelectionOptions,
): ScoreRewardSelection {
    if (scoreRewards == null || groupId == null) {
        return { plan: createRewardGrantPlan([]) }
    }

    const dropMultiplier = getServerGameplaySettingsSync().dropMultiplier
    const rewardDate = options?.rewardDate ?? getDateFromServerTime(getServerTime())
    return selectScoreRewardGrantPlanCore({
        groupId,
        scoreRewards,
        boostPointUsed,
        questElement,
        commonRewardCount: options?.commonRewardCount,
        random: options?.random,
        rewardCampaignRates: options?.rewardCampaignRates ?? { item: 1, exp: 1, mana: 1 },
        rewardDate,
        dropMultiplier,
    }, {
        getRareScoreRewardGroup,
        resolveEventCurrencyId,
        resolveContextualItemId,
    })
}
