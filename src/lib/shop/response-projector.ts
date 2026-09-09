import {
    projectCharacterPatch,
    projectEquipmentEntity,
    projectEquipmentPatch,
} from "../common-response/entities"
import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "../mission/response-fragment"
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
    const fragment: CommonResponseFragment = {
        user_info: {
            vmoney: result.playerAfter.vmoney,
            free_vmoney: result.playerAfter.freeVmoney,
            paid_mana: result.playerAfter.paidMana,
            free_mana: result.playerAfter.freeMana,
            bond_token: result.playerAfter.bondToken,
            exp_pool: result.playerAfter.expPool,
        },
        character_list: result.characters.map(character => (
            projectCharacterPatch(character.after)
        )),
        equipment_list: [
            ...result.equipmentRewards.map(equipment => (
                projectEquipmentPatch(equipment.after)
            )),
            ...result.equipmentEnhancements.map(enhancement => (
                projectEquipmentEntity(serializeEquipmentEnhancement(enhancement))
            )),
        ],
        item_list: Object.fromEntries(result.itemAfter.map(item => [
            String(item.itemId),
            item.afterAmount,
        ])),
        mission_info: [],
        ...(result.itemOverflowDispositions.length > 0
            ? {
                over_max: projectItemOverflowCommonResponse(
                    result.itemOverflowDispositions,
                ),
            }
            : {}),
    }
    const data: ShopPurchaseResponseData = {
        ...mergeCommonResponseFragments([fragment]),
        degree_list: [],
    }
    if (result.missionSettlement !== null) {
        composeMissionSettlementResponse(
            data,
            projectMissionSettlementFragment(result.missionSettlement),
            viewerId,
        )
    }
    return data
}
