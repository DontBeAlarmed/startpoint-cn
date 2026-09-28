import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../common-response/entities"
import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { StarCrumbExchangeSuccess } from "./owner"

export interface StarCrumbExchangeResponseInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: StarCrumbExchangeSuccess
    readonly characterList: readonly Record<string, unknown>[]
    readonly mailArrived: boolean
}

export function projectStarCrumbExchangeResponse(
    input: StarCrumbExchangeResponseInput,
): Record<string, unknown> {
    const overMax = projectItemOverflowCommonResponse(input.result.itemOverflowDispositions)
    const fragment: CommonResponseFragment = {
        user_info: {
            star_crumb: input.result.starCrumbAfter,
            ...(input.result.itemOverflowDispositions.some(
                disposition => disposition.kind === "sold",
            ) && input.result.freeManaAfter !== null
                ? { free_mana: input.result.freeManaAfter }
                : {}),
        },
        character_list: input.characterList.map(
            character => projectCharacterPatch(character),
        ),
        item_list: input.result.rewardItems,
        equipment_list: input.result.equipment.map(
            equipment => projectEquipmentEntity(equipment),
        ),
        mission_info: null,
        over_max: overMax.length > 0 ? overMax : null,
        mail_arrived: input.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            active_mission_list: null,
            config: null,
            user_daily_challenge_point_list: null,
            encyclopedia_info: null,
            fund_receive_list: null,
            monthly_charge_bonus_info: null,
            crazy_gacha_result_list: null,
        },
    }
}
