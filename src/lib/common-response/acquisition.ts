import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import {
    collectRewardGrantItemOverflowDispositions,
    type RewardGrantExecutionResult,
} from "../reward-grant/projection"
import { mergeCommonResponseFragments } from "./merge"
import {
    projectCharacterPatch,
    projectEquipmentEntity,
    projectEquipmentPatch,
    projectNewCharacterSnapshot,
} from "./entities"
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
    const characterFragments: CommonResponseFragment[] = []
    const joinedCharacterIds = new Set(
        input.grant.assets.characters
            .filter(entry => entry.joined)
            .map(entry => entry.characterId),
    )
    const equipmentFragments: CommonResponseFragment[] = []
    for (const entry of input.grant.entries) {
        const outcome = entry.outcome
        if (outcome.kind === "character") {
            if (outcome.after.character_id !== outcome.characterId) {
                throw new TypeError("character_id must match Character owner identity")
            }
            characterFragments.push({
                character_list: [outcome.isNew
                    ? projectNewCharacterSnapshot(outcome.after)
                    : projectCharacterPatch(outcome.after)],
            })
        } else if (outcome.kind === "equipment") {
            if (outcome.after.equipment_id !== outcome.equipmentId) {
                throw new TypeError("equipment_id must match Equipment owner identity")
            }
            equipmentFragments.push({
                equipment_list: [projectEquipmentPatch(outcome.after)],
            })
        }
    }
    if (characterFragments.length > 0) {
        const mergedCharacters = mergeCommonResponseFragments(characterFragments).character_list ?? []
        fragment.character_list = mergedCharacters.map(character => (
            joinedCharacterIds.has(character.character_id)
                ? projectNewCharacterSnapshot(character)
                : projectCharacterPatch(character)
        ))
    }
    if (equipmentFragments.length > 0) {
        const mergedEquipment = mergeCommonResponseFragments(equipmentFragments).equipment_list ?? []
        fragment.equipment_list = mergedEquipment.map(projectEquipmentEntity)
    }
    const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(input.grant)
    if (itemOverflowDispositions.length > 0) {
        fragment.over_max = projectItemOverflowCommonResponse(itemOverflowDispositions)
    }
    return fragment
}
