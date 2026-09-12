import type {
    CharacterFragment,
    CommonResponseFragment,
    CommonResponseProjection,
    CommonResponseRecord,
    EquipmentFragment,
    ItemListFragment,
} from "./model"
import {
    cloneCharacterFragment,
    cloneEquipmentFragment,
    isCommonResponseRecord,
    requirePositiveFragmentId,
} from "./clone"

function mergeRecord(
    current: CommonResponseRecord | null | undefined,
    next: CommonResponseRecord,
): CommonResponseRecord {
    const merged = (current ?? {}) as Record<string, unknown>
    for (const [field, value] of Object.entries(next)) {
        if (value !== undefined) merged[field] = value
    }
    return merged
}

function mergeCharacterList(
    current: readonly CharacterFragment[] | null | undefined,
    next: readonly CharacterFragment[],
    indexById: Map<number, number>,
): readonly CharacterFragment[] {
    const merged = (current ?? []) as CharacterFragment[]

    for (const rawFragment of next) {
        const fragment = cloneCharacterFragment(rawFragment)
        const id = requirePositiveFragmentId(fragment.character_id, "character_id")
        const existingIndex = indexById.get(id)
        if (existingIndex === undefined) {
            indexById.set(id, merged.length)
            merged.push(fragment)
            continue
        }

        const previous = merged[existingIndex]
        merged[existingIndex] = {
            ...previous,
            ...fragment,
            ...(fragment.mana_board_awake === undefined
                ? {}
                : {
                    mana_board_awake: {
                        ...(previous.mana_board_awake ?? {}),
                        ...fragment.mana_board_awake,
                    },
                }),
        }
    }
    return merged
}

function mergeEquipmentList(
    current: readonly EquipmentFragment[] | null | undefined,
    next: readonly EquipmentFragment[],
    indexById: Map<number, number>,
): readonly EquipmentFragment[] {
    const merged = (current ?? []) as EquipmentFragment[]

    for (const rawFragment of next) {
        const fragment = cloneEquipmentFragment(rawFragment)
        const id = requirePositiveFragmentId(fragment.equipment_id, "equipment_id")
        const existingIndex = indexById.get(id)
        if (existingIndex === undefined) {
            indexById.set(id, merged.length)
            merged.push(fragment)
        } else {
            merged[existingIndex] = { ...merged[existingIndex], ...fragment }
        }
    }
    return merged
}

function isLegacyEmptyItemList(value: ItemListFragment): value is readonly never[] {
    return Array.isArray(value)
}

function cloneOverflowEntry(entry: CommonResponseRecord): CommonResponseRecord {
    const cloned = mergeRecord(undefined, entry) as Record<string, unknown>
    if (isCommonResponseRecord(entry.item)) cloned.item = { ...entry.item }
    return cloned
}

function appendRecords(
    current: readonly CommonResponseRecord[] | null | undefined,
    next: readonly CommonResponseRecord[],
    clone: (entry: CommonResponseRecord) => CommonResponseRecord,
): readonly CommonResponseRecord[] {
    const merged = (current ?? []) as CommonResponseRecord[]
    merged.push(...next.map(clone))
    return merged
}

export function mergeCommonResponseFragments(
    fragments: readonly CommonResponseFragment[],
): CommonResponseProjection {
    const result: {
        user_info?: CommonResponseRecord | null
        item_list?: ItemListFragment | null
        character_list?: readonly CharacterFragment[] | null
        equipment_list?: readonly EquipmentFragment[] | null
        mission_info?: readonly CommonResponseRecord[] | null
        over_max?: readonly CommonResponseRecord[] | null
        active_mission_list?: readonly unknown[] | null
        mail_arrived?: boolean | null
    } = {}
    const characterIndexById = new Map<number, number>()
    const equipmentIndexById = new Map<number, number>()

    for (const fragment of fragments) {
        if (fragment.user_info !== undefined) {
            if (fragment.user_info !== null) {
                result.user_info = mergeRecord(result.user_info, fragment.user_info)
            } else if (result.user_info === undefined) {
                result.user_info = null
            }
        }
        if (fragment.item_list !== undefined) {
            if (fragment.item_list !== null) {
                if (isLegacyEmptyItemList(fragment.item_list)) {
                    if (fragment.item_list.length > 0) {
                        throw new TypeError("legacy item_list array must be empty")
                    }
                    if (result.item_list === undefined || result.item_list === null) {
                        result.item_list = []
                    }
                } else {
                    result.item_list = mergeRecord(
                        result.item_list !== null
                            && result.item_list !== undefined
                            && isLegacyEmptyItemList(result.item_list)
                            ? undefined
                            : result.item_list,
                        fragment.item_list,
                    ) as Readonly<Record<string, number>>
                }
            } else if (result.item_list === undefined) {
                result.item_list = null
            }
        }
        if (fragment.character_list !== undefined) {
            if (fragment.character_list !== null) {
                result.character_list = mergeCharacterList(
                    result.character_list,
                    fragment.character_list,
                    characterIndexById,
                )
            } else if (result.character_list === undefined) {
                result.character_list = null
            }
        }
        if (fragment.equipment_list !== undefined) {
            if (fragment.equipment_list !== null) {
                result.equipment_list = mergeEquipmentList(
                    result.equipment_list,
                    fragment.equipment_list,
                    equipmentIndexById,
                )
            } else if (result.equipment_list === undefined) {
                result.equipment_list = null
            }
        }
        if (fragment.mission_info !== undefined) {
            if (fragment.mission_info !== null) {
                result.mission_info = appendRecords(
                    result.mission_info,
                    fragment.mission_info,
                    entry => mergeRecord(undefined, entry),
                )
            } else if (result.mission_info === undefined) {
                result.mission_info = null
            }
        }
        if (fragment.active_mission_list !== undefined) {
            if (fragment.active_mission_list !== null) {
                result.active_mission_list = [
                    ...(result.active_mission_list ?? []),
                    ...fragment.active_mission_list,
                ]
            } else if (result.active_mission_list === undefined) {
                result.active_mission_list = null
            }
        }
        if (fragment.over_max !== undefined) {
            if (fragment.over_max !== null) {
                result.over_max = appendRecords(
                    result.over_max,
                    fragment.over_max,
                    cloneOverflowEntry,
                )
            } else if (result.over_max === undefined) {
                result.over_max = null
            }
        }
        if (fragment.mail_arrived !== undefined) {
            if (fragment.mail_arrived !== null) {
                result.mail_arrived = fragment.mail_arrived
            } else if (result.mail_arrived === undefined) {
                result.mail_arrived = null
            }
        }
    }

    return result
}
