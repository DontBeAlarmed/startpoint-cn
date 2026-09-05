import { getPlayerCharacterSync, updatePlayerCharacterSync } from "../../../data/domains/character"
import { growthError } from "../errors"
import { assertInsideTransaction } from "../mutation-support"

export interface SetCharacterExBoostCommand {
    readonly playerId: number
    readonly characterId: number
    readonly statusId: number
    readonly abilityIdList: readonly number[]
}

export interface SetCharacterExBoostResult {
    readonly updateTime: Date
}

/**
 * Persists the drawn/selected EX Boost pair (status + ability list) for one
 * character. Composes into the caller's transaction so the item deduction
 * (draw) or pending-draw cleanup (select) stays atomic with the write.
 */
export function setCharacterExBoostWithinTransactionSync(
    command: SetCharacterExBoostCommand,
): SetCharacterExBoostResult {
    assertInsideTransaction()
    if (!Number.isSafeInteger(command.playerId) || command.playerId <= 0) {
        throw growthError("INVALID_REQUEST", "playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_REQUEST", "characterId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.statusId) || command.statusId <= 0) {
        throw growthError("INVALID_REQUEST", "statusId must be a positive safe integer.")
    }
    if (!Array.isArray(command.abilityIdList)
        || command.abilityIdList.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        throw growthError("INVALID_REQUEST", "abilityIdList must contain positive safe integers.")
    }
    if (getPlayerCharacterSync(command.playerId, command.characterId) === null) {
        throw growthError("CHARACTER_NOT_OWNED", `character ${command.characterId} is not owned.`)
    }
    const characterUpdate: Parameters<typeof updatePlayerCharacterSync>[2] = {
        exBoost: { statusId: command.statusId, abilityIdList: [...command.abilityIdList] },
    }
    updatePlayerCharacterSync(command.playerId, command.characterId, characterUpdate)
    const updateTime = characterUpdate.updateTime
    if (updateTime === undefined) {
        throw growthError("INVALID_GROWTH_STATE", "EX Boost update did not record update time.")
    }
    return { updateTime }
}
