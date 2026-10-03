import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "./mission/degree-context-requirements"
import type { MissionSettlementResult } from "./mission/settlement"

// 溶解装备获得的锻块是「累计获得锻造石」状态事实的产生时点:任务 66 族
// (total_craft_point_addition_count)与锻造石称号族(cat5
// degree_craft_point_get_,condition 37)必须同事务窄域当场结算,否则奖励
// 被推迟到下次进关/任务页(2026-10-03 全量审计:cat1 唯一残留缺口;cond37
// 虽在战斗 finish 白名单内,但溶解动作发生在战斗外)。
// sell_equipment/sell_stack/bulk_sell_stack 三个溶解入口共用本结算面;
// 按前缀收窄避免误选同 cond37 的活动收集称号(其事实是特定活动道具)。
// 任务 33 奖励等其它锻块获取路径沿用兜底,由下次进关全量结算补发。
export function settleCraftPointMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const craftPointMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("total_craft_point_addition_count")
        .map(definition => definition.missionId)
    const degreeMissionIds = getMissionCatalog()
        .getDefinitions(5)
        .filter(definition => definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.craftPointGet))
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: craftPointMissionIds },
            { category: 5, missionIds: degreeMissionIds },
        ],
        evaluationTime,
    )
}
