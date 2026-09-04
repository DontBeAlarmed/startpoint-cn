import { projectItemOverflowCommonResponse } from "../item-overflow"
import type { GachaExchangeSuccess, GachaPostCommitResult } from "./model"

export function projectGachaExchangeResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: GachaExchangeSuccess
    readonly postCommit: GachaPostCommitResult
}): Record<string, unknown> {
    const result = input.result
    const overMax = projectItemOverflowCommonResponse(result.itemOverflowDispositions)
    const common = {
        gacha_info_list: [{
            gacha_id: result.gachaId,
            is_account_first: result.isAccountFirst,
            is_daily_first: result.isDailyFirst,
            gacha_exchange_point: result.exchangePoint,
        }],
        encyclopedia_info: [],
        mail_arrived: result.mailArrived,
        ...(overMax.length > 0 ? { over_max: overMax } : {}),
        ...(result.playerAfter === undefined
            ? {}
            : { user_info: { free_mana: result.playerAfter.freeMana } }),
    }
    return {
        data_headers: input.dataHeaders,
        data: result.kind === "character"
            ? {
                ...common,
                character_list: input.postCommit.characterList,
                item_list: Object.keys(result.rewardItems).length === 0
                    ? []
                    : result.rewardItems,
            }
            : {
                ...common,
                equipment_list: result.equipment,
            },
    }
}
