import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"

const DAILY_GACHA_DRAW_CONDITION_TYPE = 78

/**
 * Daily gacha-draw missions (condition 78) count character-pool draws from
 * every acquisition path — normal exec, crazy gacha, and exchange
 * redemption. The ledger increment carries its own enable-window gate and
 * must run inside the gacha transaction; the daily reset deletes category 2
 * progress, so counts stay per-day.
 */
export function recordDailyGachaDrawFacts(
    playerId: number,
    drawCount: number,
    evaluationTime: Date,
): number[] {
    if (!Number.isSafeInteger(drawCount) || drawCount <= 0) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(2)) {
        if (Number(definition.row[2]) !== DAILY_GACHA_DRAW_CONDITION_TYPE) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) continue

        incrementPlayerCategoryMissionSync(playerId, 2, definition.missionId, drawCount)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
