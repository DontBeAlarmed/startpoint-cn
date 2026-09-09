import type { CharacterFragment, CommonResponseRecord, EquipmentFragment } from "./model"

export function isCommonResponseRecord(value: unknown): value is CommonResponseRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function requirePositiveFragmentId(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value
}

function copyFields(source: CommonResponseRecord): Record<string, unknown> {
    const copied: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(source)) {
        if (value !== undefined) copied[field] = value
    }
    return copied
}

export function cloneCharacterFragment(fragment: CharacterFragment): CharacterFragment {
    requirePositiveFragmentId(fragment.character_id, "character_id")
    const cloned = copyFields(fragment)
    if (Array.isArray(fragment.bond_token_list)) {
        cloned.bond_token_list = fragment.bond_token_list.map(entry => (
            isCommonResponseRecord(entry) ? { ...entry } : entry
        ))
    }
    if (fragment.mana_board_awake !== undefined) {
        cloned.mana_board_awake = { ...fragment.mana_board_awake }
    }
    return cloned as CharacterFragment
}

export function cloneEquipmentFragment(fragment: EquipmentFragment): EquipmentFragment {
    requirePositiveFragmentId(fragment.equipment_id, "equipment_id")
    return copyFields(fragment) as EquipmentFragment
}
