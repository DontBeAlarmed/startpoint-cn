import type { PlayerCharacter, PlayerCharacterExBoost, PlayerCharacterProjectionData } from "../../data/types"
import { clientSerializeDate } from "../../data/utils/date"
import { getServerTime } from "../../utils"
import { growthError } from "./errors"
import { projectSortedBondTokens, validateAwakeLevel, validateBondTokenStatus, validateBoardIndex } from "./invariants"
import type { BondTokenStatus } from "./model"

export type CharacterGrowthProjectionField =
    | "entry_count"
    | "evolution_level"
    | "evolution_img_level"
    | "over_limit_step"
    | "protection"
    | "exp"
    | "exp_total"
    | "stack"
    | "mana_board_index"
    | "bond_token_list"
    | "mana_board_awake"
    | "ex_boost"
    | "illustration_settings"
    | "create_time"
    | "update_time"
    | "join_time"

export interface CharacterGrowthProjectionState {
    readonly characterId: number
    readonly exp: number
    readonly stack: number
    readonly protection: boolean
    readonly overLimitStep: number
    readonly evolutionLevel: number
    readonly manaBoardIndex: number
    readonly bondTokens?: ReadonlyMap<number, BondTokenStatus>
    readonly normalManaNodes?: ReadonlyMap<number, number>
    readonly awakeUnlocks?: ReadonlyMap<number, number>
}

export interface CharacterGrowthIncrementResultLike {
    readonly after: CharacterGrowthProjectionState
    readonly changedNodeIds: readonly number[]
}

export interface ProjectCharacterGrowthEntryOptions {
    readonly characterId: number
    readonly character: PlayerCharacterProjectionData
    readonly state: CharacterGrowthProjectionState
    readonly fields: readonly CharacterGrowthProjectionField[]
    readonly viewerId?: number
    readonly includeCharacterId?: boolean
    readonly dateFormat?: "client-string" | "epoch-seconds"
    readonly exBoost?: PlayerCharacterExBoost
    readonly updateTime?: Date
}

export interface ProjectCharacterGrowthIncrementOptions
    extends Omit<ProjectCharacterGrowthEntryOptions, "characterId" | "state"> {
    readonly includeChangedNodes?: boolean
    readonly nodeIds?: readonly number[]
}

export interface CharacterGrowthIncrementProjection {
    readonly character_list: readonly Record<string, unknown>[]
    readonly user_character_mana_node_list?: Readonly<
        Record<string, readonly { readonly multiplied_id: number; readonly awake_level: number }[]>
    >
}

export const FULL_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "entry_count",
    "evolution_level",
    "over_limit_step",
    "protection",
    "exp",
    "stack",
    "mana_board_index",
    "bond_token_list",
    "ex_boost",
    "illustration_settings",
    "create_time",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

export const LOAD_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "entry_count",
    "evolution_level",
    "over_limit_step",
    "protection",
    "exp",
    "stack",
    "mana_board_index",
    "bond_token_list",
    "mana_board_awake",
    "ex_boost",
    "illustration_settings",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

export const MANA_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "evolution_level",
    "evolution_img_level",
    "bond_token_list",
    "mana_board_awake",
    "create_time",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

export const EXP_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "exp",
    "exp_total",
    "create_time",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

export const STACK_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "stack",
    "create_time",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

export const OVER_LIMIT_CHARACTER_GROWTH_FIELDS = Object.freeze([
    "over_limit_step",
    "stack",
    "create_time",
    "update_time",
    "join_time",
] as const satisfies readonly CharacterGrowthProjectionField[])

function positiveSafeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a positive safe integer.`)
    }
    return value
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a non-negative safe integer.`)
    }
    return value
}

function validDate(value: Date, field: string): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a valid Date.`)
    }
    return value
}

function validateProjectionState(
    state: CharacterGrowthProjectionState,
    characterId: number,
): CharacterGrowthProjectionState {
    if (state.characterId !== characterId) {
        throw growthError("INVALID_GROWTH_STATE", "Growth projection character identity mismatch.")
    }
    if (typeof state.protection !== "boolean") {
        throw growthError("INVALID_GROWTH_STATE", "character.protection must be boolean.")
    }
    positiveSafeInteger(state.characterId, "character.id")
    nonNegativeSafeInteger(state.exp, "character.exp")
    nonNegativeSafeInteger(state.stack, "character.stack")
    nonNegativeSafeInteger(state.overLimitStep, "character.over_limit_step")
    nonNegativeSafeInteger(state.evolutionLevel, "character.evolution_level")
    validateBoardIndex(state.manaBoardIndex)
    if (state.bondTokens !== undefined) {
        for (const [boardIndex, status] of state.bondTokens) {
            validateBoardIndex(boardIndex)
            validateBondTokenStatus(status)
        }
    }
    if (state.normalManaNodes !== undefined) {
        for (const [nodeId, awakeLevel] of state.normalManaNodes) {
            positiveSafeInteger(nodeId, "manaNode.id")
            nonNegativeSafeInteger(awakeLevel, "manaNode.awake_level")
        }
    }
    if (state.awakeUnlocks !== undefined) {
        for (const [boardIndex, awakeLevel] of state.awakeUnlocks) {
            validateBoardIndex(boardIndex)
            validateAwakeLevel(awakeLevel)
        }
    }
    return state
}

function projectDate(value: Date, format: "client-string" | "epoch-seconds"): string | number {
    const date = validDate(value, "character date")
    return format === "epoch-seconds" ? getServerTime(date) : clientSerializeDate(date)
}

function projectManaBoardAwake(
    raw: ReadonlyMap<number, number> | undefined,
): Record<number, number> | undefined {
    if (raw === undefined) return undefined
    const result: Record<number, number> = {}
    for (const [rawBoardIndex, awakeLevel] of raw) {
        const boardIndex = validateBoardIndex(rawBoardIndex)
        result[boardIndex] = validateAwakeLevel(awakeLevel)
    }
    return Object.keys(result).length === 0 ? undefined : result
}

export function characterGrowthProjectionStateFromPlayerCharacter(
    characterId: number,
    character: PlayerCharacter,
): CharacterGrowthProjectionState & { readonly bondTokens: ReadonlyMap<number, BondTokenStatus> } {
    positiveSafeInteger(characterId, "characterId")
    const bondTokens = new Map<number, BondTokenStatus>()
    for (const token of character.bondTokenList) {
        const boardIndex = validateBoardIndex(token.manaBoardIndex)
        if (bondTokens.has(boardIndex)) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate bond token board ${boardIndex}.`)
        }
        bondTokens.set(boardIndex, validateBondTokenStatus(token.status))
    }
    const state = {
        characterId,
        exp: character.exp,
        stack: character.stack,
        protection: character.protection,
        overLimitStep: character.overLimitStep,
        evolutionLevel: character.evolutionLevel,
        manaBoardIndex: character.manaBoardIndex,
        bondTokens,
    }
    validateProjectionState(state, characterId)
    return state
}

export function projectCharacterGrowthEntry(
    options: ProjectCharacterGrowthEntryOptions,
): Record<string, unknown> {
    const characterId = positiveSafeInteger(options.characterId, "characterId")
    const state = validateProjectionState(options.state, characterId)
    const fields = new Set(options.fields)
    if (fields.size !== options.fields.length) {
        throw growthError("INVALID_GROWTH_STATE", "Growth projection fields must be unique.")
    }
    if (options.viewerId !== undefined) nonNegativeSafeInteger(options.viewerId, "viewerId")
    const dateFormat = options.dateFormat ?? "client-string"
    const updateTime = options.updateTime ?? options.character.updateTime
    const manaBoardAwake = projectManaBoardAwake(state.awakeUnlocks)
    const entry: Record<string, unknown> = {
        ...(options.viewerId === undefined ? {} : { viewer_id: options.viewerId }),
        ...(options.includeCharacterId === false ? {} : { character_id: characterId }),
    }

    for (const field of options.fields) {
        switch (field) {
            case "entry_count":
                entry.entry_count = nonNegativeSafeInteger(options.character.entryCount, "character.entry_count")
                break
            case "evolution_level":
                entry.evolution_level = state.evolutionLevel
                break
            case "evolution_img_level":
                entry.evolution_img_level = state.evolutionLevel
                break
            case "over_limit_step":
                entry.over_limit_step = state.overLimitStep
                break
            case "protection":
                entry.protection = state.protection
                break
            case "exp":
                entry.exp = state.exp
                break
            case "exp_total":
                entry.exp_total = state.exp
                break
            case "stack":
                entry.stack = state.stack
                break
            case "mana_board_index":
                entry.mana_board_index = state.manaBoardIndex
                break
            case "bond_token_list":
                if (state.bondTokens === undefined) {
                    throw growthError("INVALID_GROWTH_STATE", "Growth result did not observe bond tokens.")
                }
                entry.bond_token_list = projectSortedBondTokens(state.bondTokens)
                break
            case "mana_board_awake":
                if (manaBoardAwake !== undefined) entry.mana_board_awake = manaBoardAwake
                break
            case "ex_boost": {
                const exBoost = options.exBoost ?? options.character.exBoost
                if (exBoost !== undefined) {
                    entry.ex_boost = {
                        status_id: positiveSafeInteger(exBoost.statusId, "character.ex_boost.status_id"),
                        ability_id_list: exBoost.abilityIdList.map((id, index) => (
                            positiveSafeInteger(id, `character.ex_boost.ability_id_list[${index}]`)
                        )),
                    }
                }
                break
            }
            case "illustration_settings":
                if (options.character.illustrationSettings !== undefined) {
                    entry.illustration_settings = options.character.illustrationSettings.map((value, index) => (
                        nonNegativeSafeInteger(value, `character.illustration_settings[${index}]`)
                    ))
                }
                break
            case "create_time":
                entry.create_time = projectDate(options.character.joinTime, dateFormat)
                break
            case "update_time":
                entry.update_time = projectDate(updateTime, dateFormat)
                break
            case "join_time":
                entry.join_time = projectDate(options.character.joinTime, dateFormat)
                break
        }
    }
    return entry
}

export function projectCharacterGrowthIncrement(
    result: CharacterGrowthIncrementResultLike,
    options: ProjectCharacterGrowthIncrementOptions,
): CharacterGrowthIncrementProjection {
    const characterId = positiveSafeInteger(result.after.characterId, "result.after.characterId")
    const character = projectCharacterGrowthEntry({
        ...options,
        characterId,
        state: result.after,
    })
    if (options.includeChangedNodes !== true) return { character_list: [character] }
    const nodes = result.after.normalManaNodes
    if (nodes === undefined) {
        throw growthError("INVALID_GROWTH_STATE", "Growth result did not observe mana nodes.")
    }
    const seen = new Set<number>()
    const projectedNodeIds = options.nodeIds ?? result.changedNodeIds
    const entries = projectedNodeIds.map((rawNodeId, index) => {
        const nodeId = positiveSafeInteger(rawNodeId, `changedNodeIds[${index}]`)
        if (seen.has(nodeId)) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate changed node ${nodeId}.`)
        }
        seen.add(nodeId)
        const awakeLevel = nodes.get(nodeId)
        if (awakeLevel === undefined) {
            throw growthError("INVALID_GROWTH_STATE", `changed node ${nodeId} is missing from result.after.`)
        }
        return {
            multiplied_id: nodeId,
            awake_level: nonNegativeSafeInteger(awakeLevel, `manaNode ${nodeId} awake_level`),
        }
    })
    return {
        character_list: [character],
        user_character_mana_node_list: {
            [String(characterId)]: entries,
        },
    }
}
