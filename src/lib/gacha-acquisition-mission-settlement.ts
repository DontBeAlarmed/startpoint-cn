import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "./mission/degree-context-requirements"
import type { MissionSettlementResult } from "./mission/settlement"

// 角色获得(新角色入队)是「持有角色数」状态事实的产生时点:任务 32 族
// (characters_count,让新角色成为伙伴)与伙伴数称号族(cat5
// degree_companion_add_)必须同事务窄域当场结算,否则奖励被推迟到下次
// 进关/任务页(2026-10-01 时点审计)。普通抽卡/疯狂抽卡/交换所共用本结算面;
// box gacha 走独立发放链,不在本结算面内。
export function settleGachaAcquisitionMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const characterCountMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("characters_count")
        .map(definition => definition.missionId)
    const degreeMissionIds = getMissionCatalog()
        .getDefinitions(5)
        .filter(definition => definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.companionCount))
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: characterCountMissionIds },
            { category: 5, missionIds: degreeMissionIds },
        ],
        evaluationTime,
    )
}
