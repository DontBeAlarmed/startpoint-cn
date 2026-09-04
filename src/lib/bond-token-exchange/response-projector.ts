import type { BondTokenExchangeListEntry, BondTokenExchangeSuccess } from "./owner"

export interface BondTokenExchangeResponseInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: BondTokenExchangeSuccess
    readonly mailArrived: boolean
}

export function projectBondTokenExchangeResponse(
    input: BondTokenExchangeResponseInput,
): Record<string, unknown> {
    return {
        data_headers: input.dataHeaders,
        data: {
            user_info: {
                bond_token: input.result.bondTokenAfter,
            },
            character_list: null,
            item_list: null,
            equipment_list: input.result.equipment,
            active_mission_list: null,
            mission_info: null,
            over_max: null,
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

export function projectBondTokenExchangeListResponse(
    entries: readonly BondTokenExchangeListEntry[],
): Record<string, unknown>[] {
    return entries.map(entry => ({
        equipment_id: entry.equipmentId,
        exchange_count: entry.exchangeCount,
    }))
}
