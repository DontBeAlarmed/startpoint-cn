import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import type { MissionSettlementResult } from "./mission/settlement"

// 玛纳入账是「累计获得玛纳」状态事实的产生时点:任务 40 族
// (total_mana_addition_count)必须同事务窄域当场结算,否则奖励被推迟到
// 下次进关/任务页(2026-10-01 时点审计)。战斗奖励路径由 finish 全量结算
// 覆盖;结算面已接卖道具、通用资源入账(player-resource-grant,邮件附件/
// 嘉年华/登录奖励)与活动兑换过期三入口(2026-10-08 复审收口)。
export function settleManaAdditionMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const manaAdditionMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("total_mana_addition_count")
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [{ category: 1, missionIds: manaAdditionMissionIds }],
        evaluationTime,
    )
}
