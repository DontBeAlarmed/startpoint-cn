import type { MissionSettlementResult } from "../mission/settlement"

/**
 * 锻块入账 → 「累计获得锻造石」（任务 66 族）+ 锻造石称号族（cat5）的窄域
 * 结算门。惰性 require（函数体内）规避低层仓库 → 任务域的顶层依赖环；
 * 重入护栏封顶任务奖励再含锻块的病态级联；settle 抛错降级 WARN 不阻塞入账。
 * 返回本次触发的结算结果（未触发/护栏跳过/失败时为 null），供响应投影复用，
 * 避免调用方二次结算拿到「阶段已领」的空 fragment。
 */
let settling = false

export function maybeSettleCraftPointMissions(
    playerId: number,
    itemId: number,
): MissionSettlementResult | null {
    if (settling) return null
    settling = true
    try {
        const { getMissionCatalog, getMissionCatalogCraftPointItemId } = require("../mission/mission-catalog") as typeof import("../mission/mission-catalog")
        const { settleCraftPointMissions } = require("../craft-point-mission-settlement") as typeof import("../craft-point-mission-settlement")
        const { getServerDate } = require("../../utils") as typeof import("../../utils")
        if (itemId === getMissionCatalogCraftPointItemId(getMissionCatalog())) {
            return settleCraftPointMissions(playerId, getServerDate())
        }
        return null
    } catch (error) {
        console.warn("[INVENTORY] craft point mission settle failed", error)
        return null
    } finally {
        settling = false
    }
}
