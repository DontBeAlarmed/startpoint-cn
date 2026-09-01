import { getDb } from "../../../data/db"
import { getPlayerCharactersByIdsSync } from "../../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
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
import { projectSortedBondTokens } from "../invariants"
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

export interface GrantCharacterExpCommand {
    readonly playerId: number
    readonly characterIds: readonly number[]
    readonly amount: number
    readonly ignoreUpdate?: boolean
    readonly knownExpPool?: number
    readonly evaluationTime?: Date
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
    const player = getPlayerSync(command.playerId)
    if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
    const knownPool = command.knownExpPool ?? player.expPool
    const addExpList: AddExpList = []
    const characterList: ClientReturnCharacter[] = []
    const bondTokenStatusList: ClientReturnBondTokenStatusList = {}
    const context = createCharacterGrowthBatchContext({
        playerId: command.playerId,
        characterIds: ids,
    })
    const updates: { characterId: number; exp: number }[] = []
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

    if (!command.ignoreUpdate) {
        updateCharacterGrowthRowsSync(command.playerId, updates)
        if (overflowTotal > 0) {
            const afterPool = addSafeInteger(knownPool, overflowTotal, "player.expPool")
            const current = getPlayerSync(command.playerId)
            if (current === null) throw growthError("INVALID_GROWTH_STATE", "player disappeared during growth.")
            if (current.expPool !== afterPool) {
                updatePlayerSync({ id: command.playerId, expPool: afterPool })
            }
        }
    }

    const written = getPlayerCharactersByIdsSync(command.playerId, ids)
    for (const characterId of ids) {
        const character = written[String(characterId)]
        if (!character || command.ignoreUpdate) continue
        characterList.push(projectCharacterGrowthEntry({
            characterId,
            character,
            state: characterGrowthProjectionStateFromPlayerCharacter(characterId, character),
            fields: EXP_CHARACTER_GROWTH_FIELDS,
        }) as unknown as ClientReturnCharacter)
    }
    return {
        add_exp_list: addExpList,
        character_list: characterList,
        bond_token_status_list: bondTokenStatusList,
        exp_pool: addSafeInteger(knownPool, overflowTotal, "player.expPool"),
    }
}

export function grantCharacterExp(command: GrantCharacterExpCommand): RewardPlayerCharacterExpResult {
    return getDb().transaction(() => grantCharacterExpWithinTransactionSync(command))()
}

export const executeGrantCharacterExp = grantCharacterExp
