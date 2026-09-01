import type { MergedPlayerData, PlayerCharacter } from "../../../data/types"
import type { PlayerSaveRow } from "../../../data/player-save/types"
import { projectSortedBondTokens, validateAwakeLevel, validateBondTokenStatus, validateBoardIndex } from "../invariants"
import { growthError } from "../errors"
import type { BondTokenStatus } from "../model"

export const CHARACTER_GROWTH_SAVE_TABLE_NAMES = Object.freeze([
    "players_characters",
    "players_characters_bond_tokens",
    "players_characters_mana_nodes",
    "players_character_awake_unlocks",
] as const)

export type CharacterGrowthSaveTableName = typeof CHARACTER_GROWTH_SAVE_TABLE_NAMES[number]

export interface CharacterGrowthSaveTableProjection {
    readonly players_characters: readonly PlayerSaveRow[]
    readonly players_characters_bond_tokens: readonly PlayerSaveRow[]
    readonly players_characters_mana_nodes: readonly PlayerSaveRow[]
    readonly players_character_awake_unlocks: readonly PlayerSaveRow[]
}

export type MergedCharacterGrowthProjection = Pick<
    MergedPlayerData,
    "characterList"
        | "characterManaNodeList"
        | "characterManaNodeAwakeLevels"
        | "characterAwakeUnlocks"
>

export interface MergedCharacterGrowthProjectionInput {
    readonly characterList: Readonly<Record<string, PlayerCharacter>>
    readonly characterManaNodeList: Readonly<Record<string, readonly number[]>>
    readonly characterManaNodeAwakeLevels: Readonly<Record<string, Readonly<Record<number, number>>>>
    readonly characterAwakeUnlocks: Readonly<Record<string, Readonly<Record<number, number>>>>
}

function plainRows(value: unknown, table: string): readonly PlayerSaveRow[] {
    if (!Array.isArray(value)) throw new TypeError(`${table} rows must be an array`)
    return value.map((row, index) => {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
            throw new TypeError(`${table} row ${index} must be an object`)
        }
        return { ...(row as PlayerSaveRow) }
    })
}

export function projectCharacterGrowthSaveTables(
    tables: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>,
): CharacterGrowthSaveTableProjection {
    const read = (table: CharacterGrowthSaveTableName): unknown => (
        tables instanceof Map
            ? tables.get(table)
            : (tables as Readonly<Record<string, unknown>>)[table]
    )
    return {
        players_characters: plainRows(read("players_characters"), "players_characters"),
        players_characters_bond_tokens: plainRows(
            read("players_characters_bond_tokens"),
            "players_characters_bond_tokens",
        ),
        players_characters_mana_nodes: plainRows(
            read("players_characters_mana_nodes"),
            "players_characters_mana_nodes",
        ),
        players_character_awake_unlocks: plainRows(
            read("players_character_awake_unlocks"),
            "players_character_awake_unlocks",
        ),
    }
}

export function replaceProjectedCharacterGrowthSaveTables(
    tables: Map<string, PlayerSaveRow[]>,
    projection: CharacterGrowthSaveTableProjection,
): void {
    for (const table of CHARACTER_GROWTH_SAVE_TABLE_NAMES) {
        tables.set(table, projection[table].map(row => ({ ...row })))
    }
}

function positiveIntegerKey(raw: string, field: string): number {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
        throw growthError("INVALID_GROWTH_STATE", `${field} has invalid key ${raw}.`)
    }
    return value
}

function cloneCharacter(characterId: number, character: PlayerCharacter): PlayerCharacter {
    const tokens = new Map<number, BondTokenStatus>()
    for (const token of character.bondTokenList) {
        const boardIndex = validateBoardIndex(token.manaBoardIndex)
        if (tokens.has(boardIndex)) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate bond token ${characterId}/${boardIndex}.`)
        }
        tokens.set(boardIndex, validateBondTokenStatus(token.status))
    }
    return {
        ...character,
        joinTime: new Date(character.joinTime.getTime()),
        updateTime: new Date(character.updateTime.getTime()),
        bondTokenList: projectSortedBondTokens(tokens).map(token => ({
            manaBoardIndex: token.mana_board_index,
            status: token.status,
        })),
        ...(character.exBoost === undefined ? {} : {
            exBoost: {
                ...character.exBoost,
                abilityIdList: [...character.exBoost.abilityIdList],
            },
        }),
        ...(character.illustrationSettings === undefined ? {} : {
            illustrationSettings: [...character.illustrationSettings],
        }),
    }
}

export function projectMergedCharacterGrowthState(
    input: MergedCharacterGrowthProjectionInput,
): MergedCharacterGrowthProjection {
    const characterEntries = Object.entries(input.characterList)
        .map(([rawCharacterId, character]) => [
            positiveIntegerKey(rawCharacterId, "characterList"),
            character,
        ] as const)
        .sort(([left], [right]) => left - right)
    const characterIds = new Set(characterEntries.map(([characterId]) => characterId))
    const characterList = Object.fromEntries(characterEntries.map(([characterId, character]) => [
        String(characterId),
        cloneCharacter(characterId, character),
    ]))

    const characterManaNodeList: Record<string, number[]> = {}
    const characterManaNodeAwakeLevels: Record<string, Record<number, number>> = {}
    for (const [rawCharacterId, rawNodeIds] of Object.entries(input.characterManaNodeList)) {
        const characterId = positiveIntegerKey(rawCharacterId, "characterManaNodeList")
        if (!characterIds.has(characterId)) {
            throw growthError("INVALID_GROWTH_STATE", `mana nodes reference unknown character ${characterId}.`)
        }
        const nodeIds = rawNodeIds.map((nodeId, index) => {
            if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
                throw growthError("INVALID_GROWTH_STATE", `mana node ${characterId}/${index} is invalid.`)
            }
            return nodeId
        })
        if (new Set(nodeIds).size !== nodeIds.length) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate mana node for character ${characterId}.`)
        }
        nodeIds.sort((left, right) => left - right)
        characterManaNodeList[String(characterId)] = nodeIds
        const rawAwakeLevels = input.characterManaNodeAwakeLevels[rawCharacterId] ?? {}
        const awakeLevels: Record<number, number> = {}
        for (const nodeId of nodeIds) {
            const awakeLevel = rawAwakeLevels[nodeId] ?? 0
            if (!Number.isSafeInteger(awakeLevel) || awakeLevel < 0) {
                throw growthError("INVALID_GROWTH_STATE", `mana node ${characterId}/${nodeId} awake level is invalid.`)
            }
            awakeLevels[nodeId] = awakeLevel
        }
        for (const rawNodeId of Object.keys(rawAwakeLevels)) {
            if (!nodeIds.includes(Number(rawNodeId))) {
                throw growthError("INVALID_GROWTH_STATE", `awake level references unknown node ${characterId}/${rawNodeId}.`)
            }
        }
        characterManaNodeAwakeLevels[String(characterId)] = awakeLevels
    }

    for (const rawCharacterId of Object.keys(input.characterManaNodeAwakeLevels)) {
        const characterId = positiveIntegerKey(rawCharacterId, "characterManaNodeAwakeLevels")
        if (!characterIds.has(characterId) || characterManaNodeList[rawCharacterId] === undefined) {
            throw growthError("INVALID_GROWTH_STATE", `awake levels reference unknown character ${characterId}.`)
        }
    }

    const characterAwakeUnlocks: Record<string, Record<number, number>> = {}
    for (const [rawCharacterId, rawBoards] of Object.entries(input.characterAwakeUnlocks)) {
        const characterId = positiveIntegerKey(rawCharacterId, "characterAwakeUnlocks")
        if (!characterIds.has(characterId)) {
            throw growthError("INVALID_GROWTH_STATE", `Awake unlocks reference unknown character ${characterId}.`)
        }
        const boards: Record<number, number> = {}
        for (const [rawBoardIndex, rawAwakeLevel] of Object.entries(rawBoards)) {
            const boardIndex = positiveIntegerKey(rawBoardIndex, `characterAwakeUnlocks[${characterId}]`)
            boards[boardIndex] = validateAwakeLevel(rawAwakeLevel)
        }
        characterAwakeUnlocks[String(characterId)] = Object.fromEntries(
            Object.entries(boards).sort(([left], [right]) => Number(left) - Number(right)),
        )
    }

    return {
        characterList,
        characterManaNodeList,
        characterManaNodeAwakeLevels,
        characterAwakeUnlocks,
    }
}
