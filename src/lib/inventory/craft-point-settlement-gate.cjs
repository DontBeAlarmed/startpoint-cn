"use strict"
// 锻块入账 → 任务 66 族/锻造石称号族的窄域结算门（stale-guard 同款惰性 require，
// 规避低层仓库 → 任务域的顶层依赖环）。重入护栏封顶任务奖励再含锻块的级联。
let settling = false
function maybeSettleCraftPointMissions(playerId, itemId) {
    if (settling) return
    settling = true
    try {
        const missionCatalog = require("../../mission/mission-catalog")
        const { settleCraftPointMissions } = require("../../craft-point-mission-settlement")
        const { getServerDate } = require("../../utils")
        if (itemId === missionCatalog.getMissionCatalogCraftPointItemId(missionCatalog.getMissionCatalog())) {
            settleCraftPointMissions(playerId, getServerDate())
        }
    } catch (error) {
        console.warn("[INVENTORY] craft point mission settle failed", error)
    } finally {
        settling = false
    }
}
module.exports = { maybeSettleCraftPointMissions }
