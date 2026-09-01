import { getDb } from "../../../data/db"
import { getPlayerCharactersWithStoredGrowthByIdsSync } from "../../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import type { PlayerCharacter } from "../../../data/types"
import type {
    AddExpList,
    ClientReturnBondTokenStatus,
    ClientReturnBondTokenStatusList,
    ClientReturnCharacter,
    RewardPlayerCharacterExpResult,
} from "../../types"
import { createCharacterGrowthBatchContext } from "../batch-context"
import { calculateCharacterExpAfter } from "../exp-calculation"
import { growthError } from "../errors"
import { projectSortedBondTokens, validateBondTokenStatus } from "../invariants"
import type { BondTokenStatus, CharacterGrowthStoredCore } from "../model"
import {
    addSafeInteger,
    assertInsideTransaction,
    updateCharacterGrowthRowsSync,
    validateEvaluationTime,
    validateGrowthPlayerId,
    validateNonNegativeAmount,
} from "../mutation-support"
import {
    EXP_CHARACTER_GROWTH_FIELDS,
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} from "../response-projector"
import { validateCharacterGrowthStoredCore } from "../repository"

export interface GrantCharacterExpCommand {
    readonly playerId: number
    readonly characterIds: readonly number[]
    readonly amount: number
    readonly ignoreUpdate?: boolean
    readonly knownExpPool?: number
    readonly evaluationTime?: Date
}

interface GrantCharacterExpProjectionSeeds {
    readonly characters: Readonly<Record<string, PlayerCharacter>>
    readonly storedCharacters: Readonly<Record<string, CharacterGrowthStoredCore>>
    readonly bondTokens: Readonly<Record<string, ReadonlyMap<number, BondTokenStatus>>>
}

function resolveKnownExpPool(playerId: number, knownExpPool: number | undefined): number {
    if (knownExpPool !== undefined) return knownExpPool
    const player = getPlayerSync(playerId)
    if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
    return player.expPool
}

function readProjectionSeeds(
    playerId: number,
    characterIds: readonly number[],
): GrantCharacterExpProjectionSeeds {
    const storedRecords = getPlayerCharactersWithStoredGrowthByIdsSync(playerId, characterIds)
    const characters: Record<string, PlayerCharacter> = {}
    const storedCharacters: Record<string, CharacterGrowthStoredCore> = {}
    const bondTokens: Record<string, ReadonlyMap<number, BondTokenStatus>> = {}
    for (const characterId of characterIds) {
        const record = storedRecords[String(characterId)]
        const character = record?.character
        bondTokens[String(characterId)] = new Map((character?.bondTokenList ?? []).map(token => [
            token.manaBoardIndex,
            validateBondTokenStatus(token.status),
        ]))
        if (record === undefined || character === undefined) continue
        const stored = record.storedGrowth
        if (stored.protection !== 0 && stored.protection !== 1) {
            throw growthError("INVALID_GROWTH_STATE", "character.protection must be 0 or 1.")
        }
        characters[String(characterId)] = character
        storedCharacters[String(characterId)] = validateCharacterGrowthStoredCore({
            characterId: stored.id,
            exp: stored.exp,
            stack: stored.stack,
            protection: stored.protection === 1,
            overLimitStep: stored.over_limit_step,
            evolutionLevel: stored.evolution_level,
            manaBoardIndex: stored.mana_board_index,
        })
    }
    return { characters, storedCharacters, bondTokens }
}

function validateCommand(command: GrantCharacterExpCommand): number[] {
    validateGrowthPlayerId(command.playerId)
    validateNonNegativeAmount(command.amount, "amount")
    if (!Array.isArray(command.characterIds)) {
        throw growthError("INVALID_REQUEST", "characterIds must be an array.")
    }
    const ids = [...new Set(command.characterIds)]
    for (const characterId of ids) {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw growthError("INVALID_REQUEST", "characterIds must contain positive safe integers.")
        }
    }
    if (command.evaluationTime !== undefined) validateEvaluationTime(command.evaluationTime)
    if (command.knownExpPool !== undefined
        && (!Number.isSafeInteger(command.knownExpPool) || command.knownExpPool < 0)) {
        throw growthError("INVALID_GROWTH_STATE", "knownExpPool must be a non-negative safe integer.")
    }
    return ids
}

export function grantCharacterExpWithinTransactionSync(
    command: GrantCharacterExpCommand,
): RewardPlayerCharacterExpResult {
    assertInsideTransaction()
    const ids = validateCommand(command)
    const knownPool = resolveKnownExpPool(command.playerId, command.knownExpPool)
    const seeds = readProjectionSeeds(command.playerId, ids)
    const addExpList: AddExpList = []
    const characterList: ClientReturnCharacter[] = []
    const bondTokenStatusList: ClientReturnBondTokenStatusList = {}
    const context = createCharacterGrowthBatchContext({
        playerId: command.playerId,
        characterIds: ids,
        storedCharactersSnapshot: seeds.storedCharacters,
        bondTokenSnapshots: seeds.bondTokens,
    })
    const updates: { characterId: number; exp: number }[] = []
    const plannedAfterExp = new Map<number, number>()
    let overflowTotal = 0

    for (const characterId of ids) {
        const character = context.character(characterId)
        if (character === null || command.ignoreUpdate) {
            addExpList.push({
                character_id: characterId,
                add_exp: 0,
                after_exp: 379988,
                add_exp_pool: 0,
            } as AddExpList[number])
            bondTokenStatusList[characterId] = { before: [], after: [] }
            continue
        }
        const calculation = calculateCharacterExpAfter(
            character.rarity,
            character.overLimitStep,
            character.exp,
            command.amount,
        )
        updates.push({ characterId, exp: calculation.afterExp })
        plannedAfterExp.set(characterId, calculation.afterExp)
        overflowTotal = addSafeInteger(overflowTotal, calculation.overflowExp, "player.expPool")
        addExpList.push({
            character_id: characterId,
            add_exp: calculation.characterExpAdded,
            after_exp: calculation.afterExp,
            add_exp_pool: calculation.overflowExp,
        })
        const tokens: ClientReturnBondTokenStatus[] = projectSortedBondTokens(
            context.bondTokens(characterId),
        )
        bondTokenStatusList[characterId] = { before: tokens, after: tokens }
    }

    const afterPool = addSafeInteger(knownPool, overflowTotal, "player.expPool")
    let updateTime: Date | null = null
    if (!command.ignoreUpdate) {
        updateTime = updateCharacterGrowthRowsSync(command.playerId, updates)
        if (overflowTotal > 0) {
            updatePlayerSync({ id: command.playerId, expPool: afterPool })
        }
    }

    for (const characterId of ids) {
        const character = seeds.characters[String(characterId)]
        if (!character || command.ignoreUpdate) continue
        const afterExp = plannedAfterExp.get(characterId)
        if (afterExp === undefined || updateTime === null) {
            throw growthError("INVALID_GROWTH_STATE", "character EXP after-state is unavailable.")
        }
        const state = characterGrowthProjectionStateFromPlayerCharacter(characterId, character)
        characterList.push(projectCharacterGrowthEntry({
            characterId,
            character,
            state: { ...state, exp: afterExp },
            fields: EXP_CHARACTER_GROWTH_FIELDS,
            updateTime,
        }) as unknown as ClientReturnCharacter)
    }
    return {
        add_exp_list: addExpList,
        character_list: characterList,
        bond_token_status_list: bondTokenStatusList,
        exp_pool: afterPool,
    }
}

export function grantCharacterExp(command: GrantCharacterExpCommand): RewardPlayerCharacterExpResult {
    return getDb().transaction(() => grantCharacterExpWithinTransactionSync(command))()
}

export const executeGrantCharacterExp = grantCharacterExp
