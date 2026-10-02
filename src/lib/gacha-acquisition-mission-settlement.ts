import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "./mission/degree-context-requirements"
import type { MissionSettlementResult } from "./mission/settlement"

// 角色获得(新角色入队)是「持有角色数」状态事实的产生时点:任务 32 族
// (characters_count,让新角色成为伙伴)与伙伴数称号族(cat5
// degree_companion_add_)必须同事务窄域当场结算;新装备种类同理驱动任务 33
// 族(got_equip_kind_count,获得新装备)。奖励若推迟到下次进关/任务页才补发
// 即为 2026-10-01 时点审计所指的时点混乱。普通抽卡/疯狂抽卡/交换所/box
// gacha 共用本结算面;教程发号(tutorial)在教程战斗内即有 cat1 结算兜底;
// 商店/邮件/礼物等非抽卡装备入口沿用既有范围,由下次进关全量结算兜底。
export function settleGachaAcquisitionMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const acquisitionMissionIds = [
        ...getMissionCatalog().getDefinitionsByPattern("characters_count"),
        ...getMissionCatalog().getDefinitionsByPattern("got_equip_kind_count"),
    ].map(definition => definition.missionId)
    const degreeMissionIds = getMissionCatalog()
        .getDefinitions(5)
        .filter(definition => definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.companionCount))
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: acquisitionMissionIds },
            { category: 5, missionIds: degreeMissionIds },
        ],
        evaluationTime,
    )
}
