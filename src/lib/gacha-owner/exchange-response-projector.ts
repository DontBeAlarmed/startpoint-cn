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
import type { GachaExchangeSuccess, GachaPostCommitResult } from "./model"

export function projectGachaExchangeResponse(input: {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly viewerId: number
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
    const responseData: Record<string, unknown> = { ...mergeCommonResponseFragments([fragment]) }
    if (result.missionSettlement !== null) {
        // 交换获得新角色跨过持有数任务/称号阶段时,完成与奖励在 exchange 响应内当场发布
        composeMissionSettlementResponse(
            responseData,
            projectMissionSettlementFragment(result.missionSettlement),
            input.viewerId,
        )
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...responseData,
            active_mission_list: result.activeMissionList,
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
