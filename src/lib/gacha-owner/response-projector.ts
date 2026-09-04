import { projectItemOverflowCommonResponse } from "../item-overflow"
import type { GachaExecSuccess, GachaPostCommitResult } from "./model"

export function projectGachaExecResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: GachaExecSuccess
    readonly postCommit: GachaPostCommitResult
}): Record<string, unknown> {
    const { result } = input
    const overMax = projectItemOverflowCommonResponse(
        result.itemOverflowDispositions,
    )
    const common = {
        user_info: {
            free_vmoney: result.freeVmoney,
            vmoney: result.paidVmoney,
            ...(result.playerAfter === undefined
                ? {}
                : { free_mana: result.playerAfter.freeMana }),
        },
        item_list: {
            ...result.ticketItemBalances,
            ...result.rewardItems,
        },
        gacha_info_list: [{
            gacha_id: result.gachaId,
            is_account_first: result.isAccountFirst,
            is_daily_first: result.isDailyFirst,
            gacha_exchange_point: result.exchangePoint,
        }],
        encyclopedia_info: [],
        mail_arrived: result.mailArrived,
        ...(overMax.length > 0 ? { over_max: overMax } : {}),
    }
    return {
        data_headers: input.dataHeaders,
        data: result.kind === "character"
            ? {
                ...common,
                draw: result.draw,
                character_list: input.postCommit.characterList,
                gacha_campaign_list: result.campaignList.map(campaign => ({
                    gacha_id: campaign.gachaId,
                    campaign_id: campaign.campaignId,
                    count: campaign.count,
                })),
            }
            : {
                ...common,
                is_erupt: result.isErupt,
                draw_equipment: result.draw,
                equipment_list: result.equipment,
            },
    }
}
