import { settleMissionCategories } from "./mission/settlement"
import { getMissionCatalog } from "./mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "./mission/degree-context-requirements"
import { getServerDate } from "../utils"
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

// 获得写入点钩子（character/equipment）的失败策略门——与锻块入账结算门
// 同一口径：任务进度是派生态、可由下次进关全量结算修复，settle 抛错降级
// WARN 不连坐角色/装备获得本身。in-flight 护栏同时封顶「任务奖励再发
// 角色/装备」的重入级联（角色侧原护栏语义并入此处）。
let settlingAtWritePoint = false

// R-07：返回结算结果（调用方可投影 mission_info）；失败 WARN 时返回 null
export function settleAcquisitionMissionsAtWritePoint(playerId: number): MissionSettlementResult | null {
    if (settlingAtWritePoint) return null
    settlingAtWritePoint = true
    try {
        return settleGachaAcquisitionMissions(playerId, getServerDate())
    } catch (error) {
        console.warn("[MISSION] acquisition mission settle at write point failed", error)
        return null
    } finally {
        settlingAtWritePoint = false
    }
}
