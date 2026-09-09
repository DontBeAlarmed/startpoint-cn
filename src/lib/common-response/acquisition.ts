import type { PlannedItemOverflowDisposition } from "../item-overflow/disposition"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { RewardGrantExecutionResult } from "../reward-grant"
import { cloneCharacterFragment, cloneEquipmentFragment } from "./clone"
import type {
    CharacterFragment,
    CommonResponseFragment,
    CommonResponseRecord,
    EquipmentFragment,
    ItemListFragment,
} from "./model"

export interface AcquisitionCurrencyAfterState {
    readonly freeMana?: number
    readonly freeVmoney?: number
    readonly paidVmoney?: number
    readonly expPool?: number
}

const ACQUISITION_CURRENCY_WIRE_FIELDS: readonly (readonly [
    keyof AcquisitionCurrencyAfterState,
    string,
])[] = [
    ["freeMana", "free_mana"],
    ["freeVmoney", "free_vmoney"],
    ["paidVmoney", "vmoney"],
    ["expPool", "exp_pool"],
]

export function projectAcquisitionCurrencyUserInfo(
    afterState: AcquisitionCurrencyAfterState,
): CommonResponseRecord {
    const userInfo: Record<string, number> = {}
    for (const [ownerField, wireField] of ACQUISITION_CURRENCY_WIRE_FIELDS) {
        const value = afterState[ownerField]
        if (value === undefined) continue
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
            throw new TypeError(`${ownerField} must be a non-negative safe integer`)
        }
        userInfo[wireField] = value
    }
    return userInfo
}

export interface RewardGrantAcquisitionFragmentInput {
    readonly grant: RewardGrantExecutionResult
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
}

export function projectRewardGrantAcquisitionFragment(
    input: RewardGrantAcquisitionFragmentInput,
): CommonResponseFragment {
    const fragment: {
        user_info?: CommonResponseRecord | null
        item_list?: ItemListFragment | null
        character_list?: readonly CharacterFragment[] | null
        equipment_list?: readonly EquipmentFragment[] | null
        over_max?: readonly CommonResponseRecord[] | null
    } = {
        user_info: projectAcquisitionCurrencyUserInfo(input.grant.playerAfter),
    }

    const itemList: Record<string, number> = {}
    for (const item of input.grant.assets.items) {
        itemList[String(item.itemId)] = item.afterAmount
    }
    if (Object.keys(itemList).length > 0) fragment.item_list = itemList
    if (input.grant.assets.characters.length > 0) {
        fragment.character_list = input.grant.assets.characters.map(
            entry => cloneCharacterFragment(entry.after as unknown as CharacterFragment),
        )
    }
    if (input.grant.assets.equipment.length > 0) {
        fragment.equipment_list = input.grant.assets.equipment.map(
            entry => cloneEquipmentFragment(entry.after as unknown as EquipmentFragment),
        )
    }
    if (input.itemOverflowDispositions.length > 0) {
        fragment.over_max = projectItemOverflowCommonResponse(input.itemOverflowDispositions)
    }
    return fragment
}
