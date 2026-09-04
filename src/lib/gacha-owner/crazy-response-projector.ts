import { projectItemOverflowCommonResponse } from "../item-overflow"
import type {
    CrazyGachaCandidateSuccess,
    CrazyGachaSaveSuccess,
    CrazyGachaSelectSuccess,
    GachaPostCommitResult,
} from "./model"

function slotMap(slots: Readonly<Record<number, readonly number[]>>): Record<string, number[]> {
    return Object.fromEntries(Object.entries(slots).map(([slot, characterIds]) => [
        slot,
        [...characterIds],
    ]))
}

export function projectCrazyGachaCandidateResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: CrazyGachaCandidateSuccess
}): Record<string, unknown> {
    return {
        data_headers: input.dataHeaders,
        data: {
            draw: input.result.draw,
            item_list: input.result.ticketItemBalances,
            gacha_info_list: [{
                gacha_id: input.result.gachaId,
                is_account_first: input.result.isAccountFirst,
                is_daily_first: input.result.isDailyFirst,
                gacha_exchange_point: input.result.exchangePoint,
                crazy_draw_count: input.result.crazyDrawCount,
            }],
            crazy_gacha_result_list: slotMap(input.result.slots),
        },
    }
}

export function projectCrazyGachaSaveResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: CrazyGachaSaveSuccess
}): Record<string, unknown> {
    return {
        data_headers: input.dataHeaders,
        data: { crazy_gacha_result_list: slotMap(input.result.slots) },
    }
}

export function projectCrazyGachaSelectResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: CrazyGachaSelectSuccess
    readonly postCommit: GachaPostCommitResult
}): Record<string, unknown> {
    const overMax = projectItemOverflowCommonResponse(input.result.itemOverflowDispositions)
    return {
        data_headers: input.dataHeaders,
        data: {
            character_list: input.postCommit.characterList,
            item_list: input.result.rewardItems,
            ...(input.result.playerAfter === undefined ? {} : { user_info: {
                free_mana: input.result.playerAfter.freeMana,
                free_vmoney: input.result.playerAfter.freeVmoney,
            } }),
            crazy_gacha_result_list: {},
            mail_arrived: input.result.mailArrived,
            ...(overMax.length === 0 ? {} : { over_max: overMax }),
        },
    }
}
