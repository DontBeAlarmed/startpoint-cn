import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import { projectCharacterPatch, projectEquipmentEntity } from "../common-response/entities"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type {
    SpecialExchangeBuyTicketSuccess,
    SpecialExchangeEnterSuccess,
    SpecialExchangeTargetSuccess,
} from "./owner"

function specialExchangeCampaignEntry(
    campaignId: number,
    status: number,
): Record<string, unknown> {
    return { campaign_id: campaignId, status }
}

export function projectSpecialExchangeEnterResponse(
    input: SpecialExchangeEnterSuccess,
): Record<string, unknown> {
    return {
        data: {
            special_exchange_campaign_list: [
                specialExchangeCampaignEntry(input.campaign.campaignId, input.status),
            ],
        },
    }
}

export interface SpecialExchangeBuyTicketResponseInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: SpecialExchangeBuyTicketSuccess
    readonly mailArrived: boolean
}

export function projectSpecialExchangeBuyTicketResponse(
    input: SpecialExchangeBuyTicketResponseInput,
): Record<string, unknown> {
    const fragment: CommonResponseFragment = {
        user_info: {
            vmoney: input.result.paidVmoneyAfter,
            free_vmoney: input.result.freeVmoneyAfter,
        },
        character_list: null,
        item_list: input.result.items,
        equipment_list: null,
        mission_info: null,
        over_max: null,
        mail_arrived: input.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            special_exchange_campaign_list: [
                specialExchangeCampaignEntry(input.result.campaign.campaignId, input.result.status),
            ],
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

export interface SpecialExchangeTargetResponseInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: SpecialExchangeTargetSuccess
    readonly characterList: readonly Record<string, unknown>[]
    readonly mailArrived: boolean
}

export function projectSpecialExchangeTargetResponse(
    input: SpecialExchangeTargetResponseInput,
): Record<string, unknown> {
    const overMax = projectItemOverflowCommonResponse(input.result.itemOverflowDispositions)
    const fragment: CommonResponseFragment = {
        user_info: input.result.freeManaAfter === null
            ? null
            : { free_mana: input.result.freeManaAfter },
        character_list: input.result.campaign.type === 0
            ? input.characterList.map(character => projectCharacterPatch(character))
            : null,
        item_list: input.result.items,
        equipment_list: input.result.campaign.type === 1
            ? input.result.equipment.map(equipment => projectEquipmentEntity(equipment))
            : null,
        mission_info: null,
        over_max: overMax.length > 0 ? overMax : null,
        mail_arrived: input.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            special_exchange_campaign_list: [
                specialExchangeCampaignEntry(input.result.campaign.campaignId, input.result.status),
            ],
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
