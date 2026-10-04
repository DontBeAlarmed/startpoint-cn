import { settleMissionCategories } from "../mission/settlement"
import { getMissionCatalog } from "../mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "../mission/degree-context-requirements"
import type { MissionSettlementResult } from "../mission/settlement"

// 上限突破是「各角色 overLimitStep 求和」状态事实的产生时点:任务 38 族
// (over_limit_total_count)与突破称号族(cat5 degree_overlimit_growth_,
// condition 9 不在战斗 finish 的 degree 结算白名单)必须同事务窄域当场
// 结算,否则奖励被推迟到下次进关/任务页(2026-10-01 时点审计)。
// 单次与批量突破共用本结算面。
export function settleOverLimitMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const overLimitMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("over_limit_total_count")
        .map(definition => definition.missionId)
    const degreeMissionIds = getMissionCatalog()
        .getDefinitions(5)
        .filter(definition => definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.overLimitCount))
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: overLimitMissionIds },
            { category: 5, missionIds: degreeMissionIds },
        ],
        evaluationTime,
    )
}
