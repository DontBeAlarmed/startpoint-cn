import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../common-response/entities"
import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { GachaExchangeSuccess, GachaPostCommitResult } from "./model"

export function projectGachaExchangeResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: GachaExchangeSuccess
    readonly postCommit: GachaPostCommitResult
}): Record<string, unknown> {
    const result = input.result
    const overMax = projectItemOverflowCommonResponse(result.itemOverflowDispositions)
    const fragment: CommonResponseFragment = {
        mail_arrived: result.mailArrived,
        ...(overMax.length > 0 ? { over_max: overMax } : {}),
        ...(result.playerAfter === undefined
            ? {}
            : { user_info: { free_mana: result.playerAfter.freeMana } }),
        ...(result.kind === "character"
            ? {
                character_list: input.postCommit.characterList.map(
                    character => projectCharacterPatch(character),
                ),
                item_list: Object.keys(result.rewardItems).length === 0
                    ? []
                    : result.rewardItems,
            }
            : {
                equipment_list: result.equipment.map(
                    equipment => projectEquipmentEntity(equipment),
                ),
            }),
    }
    const common = mergeCommonResponseFragments([fragment])
    return {
        data_headers: input.dataHeaders,
        data: {
            ...common,
            gacha_info_list: [{
                gacha_id: result.gachaId,
                is_account_first: result.isAccountFirst,
                is_daily_first: result.isDailyFirst,
                gacha_exchange_point: result.exchangePoint,
            }],
            encyclopedia_info: [],
        },
    }
}
