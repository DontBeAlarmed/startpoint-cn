import { isCommonResponseRecord, requirePositiveFragmentId } from "./clone"
import type { CharacterFragment, EquipmentFragment } from "./model"

const CHARACTER_FIELDS = new Set([
    "character_id",
    "viewer_id",
    "entry_count",
    "evolution_level",
    "evolution_img_level",
    "over_limit_step",
    "protection",
    "exp",
    "exp_total",
    "stack",
    "mana_board_index",
    "bond_token_list",
    "mana_board_awake",
    "ex_boost",
    "illustration_settings",
    "create_time",
    "update_time",
    "join_time",
])

const EQUIPMENT_FIELDS = new Set([
    "equipment_id",
    "protection",
    "level",
    "enhancement_level",
    "stack",
])

function copyCharacterValue(field: string, value: unknown): unknown {
    if (field === "bond_token_list" && Array.isArray(value)) {
        return value.map(entry => isCommonResponseRecord(entry) ? { ...entry } : entry)
    }
    if (field === "mana_board_awake" && isCommonResponseRecord(value)) {
        return { ...value }
    }
    if (field === "ex_boost" && isCommonResponseRecord(value)) {
        return {
            ...value,
            ...(Array.isArray(value.ability_id_list)
                ? { ability_id_list: [...value.ability_id_list] }
                : {}),
        }
    }
    if (field === "illustration_settings" && Array.isArray(value)) {
        return [...value]
    }
    return value
}

function projectCharacterFields(input: unknown): Record<string, unknown> {
    if (!isCommonResponseRecord(input)) throw new TypeError("Character fragment must be an object")
    const characterId = requirePositiveFragmentId(input.character_id, "character_id")
    const result: Record<string, unknown> = { character_id: characterId }
    for (const [field, value] of Object.entries(input)) {
        if (field !== "character_id" && CHARACTER_FIELDS.has(field) && value !== undefined) {
            result[field] = copyCharacterValue(field, value)
        }
    }
    return result
}

function requireNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value
}

function requireCharacterTime(value: unknown, field: string): string | number {
    if (typeof value === "string") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    throw new TypeError(`${field} must be a client date string or finite epoch number`)
}

export function projectCharacterPatch(input: unknown): CharacterFragment {
    return projectCharacterFields(input) as CharacterFragment
}

export function projectNewCharacterSnapshot(input: unknown): CharacterFragment {
    const result = projectCharacterFields(input)
    requireNonNegativeInteger(result.entry_count, "entry_count")
    if (!Array.isArray(result.bond_token_list)) {
        throw new TypeError("bond_token_list must be an array")
    }
    requireCharacterTime(result.join_time, "join_time")
    requireCharacterTime(result.update_time, "update_time")
    return result as CharacterFragment
}

function projectEquipmentFields(input: unknown): Record<string, unknown> {
    if (!isCommonResponseRecord(input)) throw new TypeError("Equipment fragment must be an object")
    const equipmentId = requirePositiveFragmentId(input.equipment_id, "equipment_id")
    const result: Record<string, unknown> = { equipment_id: equipmentId }
    for (const [field, value] of Object.entries(input)) {
        if (field !== "equipment_id" && EQUIPMENT_FIELDS.has(field) && value !== undefined) {
            result[field] = value
        }
    }
    return result
}

export function projectEquipmentPatch(input: unknown): EquipmentFragment {
    return projectEquipmentFields(input) as EquipmentFragment
}

export function projectEquipmentEntity(input: unknown): EquipmentFragment {
    const result = projectEquipmentFields(input)
    if (typeof result.protection !== "boolean") {
        throw new TypeError("protection must be boolean")
    }
    for (const field of ["level", "enhancement_level", "stack"]) {
        requireNonNegativeInteger(result[field], field)
    }
    return result as EquipmentFragment
}
