/**
 * 锻块入账 → 「累计获得锻造石」（任务 66 族）+ 锻造石称号族（cat5）的窄域
 * 结算门。惰性 require（函数体内）规避低层仓库 → 任务域的顶层依赖环；
 * 重入护栏封顶任务奖励再含锻块的病态级联；settle 抛错降级 WARN 不阻塞入账。
 */
let settling = false

export function maybeSettleCraftPointMissions(playerId: number, itemId: number): void {
    if (settling) return
    settling = true
    try {
        const { getMissionCatalog, getMissionCatalogCraftPointItemId } = require("../mission/mission-catalog") as typeof import("../mission/mission-catalog")
        const { settleCraftPointMissions } = require("../craft-point-mission-settlement") as typeof import("../craft-point-mission-settlement")
        const { getServerDate } = require("../../utils") as typeof import("../../utils")
        if (itemId === getMissionCatalogCraftPointItemId(getMissionCatalog())) {
            settleCraftPointMissions(playerId, getServerDate())
        }
    } catch (error) {
        console.warn("[INVENTORY] craft point mission settle failed", error)
    } finally {
        settling = false
    }
}
