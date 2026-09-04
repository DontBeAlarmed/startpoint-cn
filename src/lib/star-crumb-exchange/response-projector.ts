import { projectItemOverflowCommonResponse } from "../item-overflow"
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
    return {
        data_headers: input.dataHeaders,
        data: {
            user_info: {
                star_crumb: input.result.starCrumbAfter,
                ...(input.result.itemOverflowDispositions.some(
                    disposition => disposition.kind === "sold",
                ) && input.result.freeManaAfter !== null
                    ? { free_mana: input.result.freeManaAfter }
                    : {}),
            },
            character_list: input.characterList,
            item_list: input.result.rewardItems,
            equipment_list: input.result.equipment,
            active_mission_list: null,
            mission_info: null,
            over_max: overMax.length > 0 ? overMax : null,
            mail_arrived: input.mailArrived,
            config: null,
            user_daily_challenge_point_list: null,
            encyclopedia_info: null,
            fund_receive_list: null,
            monthly_charge_bonus_info: null,
            crazy_gacha_result_list: null,
        },
    }
}
