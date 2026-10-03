import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import { getDegreeMissionIdsForConditionTypes } from "./mission/degree-candidates"
import type { MissionSettlementResult } from "./mission/settlement"

// 溶解装备获得的锻块是「累计获得锻造石」状态事实的产生时点:任务 66 族
// (total_craft_point_addition_count)与锻造石称号族(cat5 condition 37,
// degree_craft_point_get_)必须同事务窄域当场结算,否则奖励被推迟到下次
// 进关/任务页(2026-10-03 全量审计:cat1 唯一残留缺口;cond37 虽在战斗
// finish 白名单内,但溶解动作发生在战斗外)。
export function settleCraftPointMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const craftPointMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("total_craft_point_addition_count")
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: craftPointMissionIds },
            { category: 5, missionIds: getDegreeMissionIdsForConditionTypes([37]) },
        ],
        evaluationTime,
    )
}
