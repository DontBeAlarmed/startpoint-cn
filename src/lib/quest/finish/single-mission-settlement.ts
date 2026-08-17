import { settleMissionCategories } from "../../mission"
import type { MissionSettlementRewardDependencies } from "../../mission/settlement-write"
import { buildBattleMissionSettlementScopes } from "../../mission/battle-facts"

export function settleSingleBattleMissionCategories(
    playerId: number,
    characterIds: readonly number[],
    evaluationTime: Date,
    dependencies: MissionSettlementRewardDependencies,
): ReturnType<typeof settleMissionCategories> {
    return settleMissionCategories(
        playerId,
        buildBattleMissionSettlementScopes(characterIds),
        evaluationTime,
        undefined,
        dependencies,
    )
}
