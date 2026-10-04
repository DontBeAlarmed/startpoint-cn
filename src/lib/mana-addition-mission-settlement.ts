import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import type { MissionSettlementResult } from "./mission/settlement"

// 玛纳入账是「累计获得玛纳」状态事实的产生时点:任务 40 族
// (total_mana_addition_count)必须同事务窄域当场结算,否则奖励被推迟到
// 下次进关/任务页(2026-10-01 时点审计)。战斗奖励路径由 finish 全量结算
// 覆盖;本结算面接卖道具的显式玩家动作。活动兑换过期(event-trade-expiry)、
// 嘉年华(carnival)与通用资源入账(player-resource-grant,邮件附件)沿用
// 兜底,由下次进关全量结算补发。
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
