import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../common-response/entities"
import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "../mission/response-fragment"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { GachaExecSuccess, GachaPostCommitResult } from "./model"

export function projectGachaExecResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly viewerId: number
    readonly result: GachaExecSuccess
    readonly postCommit: GachaPostCommitResult
}): Record<string, unknown> {
    const { result } = input
    const overMax = projectItemOverflowCommonResponse(
        result.itemOverflowDispositions,
    )
    const fragment: CommonResponseFragment = {
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
        mail_arrived: result.mailArrived,
        active_mission_list: result.activeMissionList,
        ...(result.kind === "character"
            ? {
                character_list: input.postCommit.characterList.map(
                    character => projectCharacterPatch(character),
                ),
            }
            : {}),
        ...(result.kind === "equipment"
            ? {
                equipment_list: result.equipment.map(
                    equipment => projectEquipmentEntity(equipment),
                ),
            }
            : {}),
        ...(overMax.length > 0 ? { over_max: overMax } : {}),
    }
    const responseData: Record<string, unknown> = { ...mergeCommonResponseFragments([fragment]) }
    if (result.missionSettlement !== null) {
        // 抽到新角色跨过持有数任务/称号阶段时,完成与奖励在 exec 响应内当场发布
        composeMissionSettlementResponse(
            responseData,
            projectMissionSettlementFragment(result.missionSettlement),
            input.viewerId,
        )
    }
    return {
        data_headers: input.dataHeaders,
        data: result.kind === "character"
            ? {
                ...responseData,
                gacha_info_list: [{
                    gacha_id: result.gachaId,
                    is_account_first: result.isAccountFirst,
                    is_daily_first: result.isDailyFirst,
                    gacha_exchange_point: result.exchangePoint,
                }],
                encyclopedia_info: [],
                draw: result.draw,
                gacha_campaign_list: result.campaignList.map(campaign => ({
                    gacha_id: campaign.gachaId,
                    campaign_id: campaign.campaignId,
                    count: campaign.count,
                })),
                ...(result.starsCampaignList.length === 0 ? {} : {
                    stars_gacha_campaign_list: result.starsCampaignList.map(campaign => ({
                        campaign_id: campaign.campaignId,
                        free_one_times: campaign.freeOneTimes,
                        free_ten_times: campaign.freeTenTimes,
                    })),
                }),
            }
            : {
                ...responseData,
                gacha_info_list: [{
                    gacha_id: result.gachaId,
                    is_account_first: result.isAccountFirst,
                    is_daily_first: result.isDailyFirst,
                    gacha_exchange_point: result.exchangePoint,
                }],
                encyclopedia_info: [],
                is_erupt: result.isErupt,
                draw_equipment: result.draw,
            },
    }
}
