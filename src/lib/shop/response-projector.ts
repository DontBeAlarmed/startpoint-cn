import { projectItemOverflowCommonResponse } from "../item-overflow"
import { mergeMissionSettlementResponse } from "../mission/response"
import type { ShopPurchaseOwnerResult } from "./result"

export type ShopPurchaseResponseData = Record<string, any>

function serializeEquipmentEnhancement(
    enhancement: ShopPurchaseOwnerResult["equipmentEnhancements"][number],
): Record<string, unknown> {
    return {
        equipment_id: enhancement.equipmentId,
        protection: enhancement.after.protection,
        level: enhancement.after.level,
        enhancement_level: enhancement.after.enhancementLevel,
        stack: enhancement.after.stack,
    }
}

export function projectShopPurchaseResponse(
    result: ShopPurchaseOwnerResult,
    viewerId: number,
): ShopPurchaseResponseData {
    const data: ShopPurchaseResponseData = {
        user_info: {
            vmoney: result.playerAfter.vmoney,
            free_vmoney: result.playerAfter.freeVmoney,
            paid_mana: result.playerAfter.paidMana,
            free_mana: result.playerAfter.freeMana,
            bond_token: result.playerAfter.bondToken,
            exp_pool: result.playerAfter.expPool,
        },
        character_list: result.characters.map(character => character.after),
        equipment_list: [
            ...result.equipmentRewards.map(equipment => equipment.after),
            ...result.equipmentEnhancements.map(serializeEquipmentEnhancement),
        ],
        item_list: Object.fromEntries(result.itemAfter.map(item => [
            String(item.itemId),
            item.afterAmount,
        ])),
        mission_info: [],
        degree_list: [],
    }
    const overMax = projectItemOverflowCommonResponse(result.itemOverflowDispositions)
    if (overMax.length > 0) data.over_max = overMax
    if (result.missionSettlement !== null) {
        mergeMissionSettlementResponse(data, result.missionSettlement, viewerId)
    }
    return data
}
