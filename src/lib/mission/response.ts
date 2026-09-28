import type { MissionSettlementResult } from "./settlement"
import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "./response-fragment"

type ResponseRecord = Record<string, unknown>

export function mergeMissionSettlementResponse(
    data: ResponseRecord,
    settlement: MissionSettlementResult,
    viewerId: number,
): void {
    const fragment = projectMissionSettlementFragment(settlement)
    const common = { ...fragment.common }
    if (!Object.prototype.hasOwnProperty.call(data, "character_list")
        && Array.isArray(common.character_list)
        && common.character_list.length === 0) {
        delete common.character_list
    }
    if (!Object.prototype.hasOwnProperty.call(data, "equipment_list")
        && Array.isArray(common.equipment_list)
        && common.equipment_list.length === 0) {
        delete common.equipment_list
    }
    composeMissionSettlementResponse(data, { ...fragment, common }, viewerId)
}
