import type { PlayerEquipment } from "../../data/types"
import {
    getAbilitySoulEquipMissionIds,
    getMissionOperationMissionIds,
    recordAbilitySoulEquipFactsSync,
    recordMissionOperationFactsSync,
    type AbilitySoulLoadout,
    type DegreeOperationKind,
} from "./degree-operation-facts"
import { settleMissionCategories, type MissionSettlementResult } from "./settlement"

export function settleAbilitySoulEquipFactsSync(
    playerId: number,
    previous: readonly AbilitySoulLoadout[],
    current: readonly AbilitySoulLoadout[],
    evaluationTime: Date,
): { amount: number, settlement: MissionSettlementResult | null } {
    const amount = recordAbilitySoulEquipFactsSync(playerId, previous, current)
    if (amount <= 0) return { amount: 0, settlement: null }

    const missionIds = getAbilitySoulEquipMissionIds()
    return {
        amount,
        settlement: settleMissionCategories(playerId, [
            { category: 1, missionIds: missionIds.regular },
            { category: 5, missionIds: missionIds.degree },
        ], evaluationTime),
    }
}

export function settleMissionOperationFactsSync(
    playerId: number,
    kind: DegreeOperationKind,
    amount: number,
    evaluationTime: Date,
    equipment?: Record<string, PlayerEquipment>,
): MissionSettlementResult | null {
    if (!Number.isSafeInteger(amount) || amount <= 0) return null
    recordMissionOperationFactsSync(playerId, kind, amount)
    const missionIds = getMissionOperationMissionIds(kind)
    return settleMissionCategories(playerId, [
        { category: 1, missionIds: missionIds.regular },
        { category: 5, missionIds: missionIds.degree },
    ], evaluationTime, undefined, equipment ? { factSeeds: { equipment } } : undefined)
}
