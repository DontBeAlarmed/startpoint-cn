import { getDb } from "../../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { updatePlayerCharacterBondTokenSync } from "../../../data/domains/character"
import { createCharacterGrowthRequestContext } from "../request-context"
import { growthError } from "../errors"
import { getBondTokenStatus } from "../invariants"
import type { BondTokenStatus, CharacterGrowthCoreFact } from "../model"
import type { CharacterGrowthCommandResult, CharacterGrowthObservedState } from "../result"

export interface ReceiveBondTokenCommand {
    readonly playerId: number
    readonly characterId: number
    readonly manaBoardIndex: number
    readonly evaluationTime: Date
}

export interface ReceiveBondTokenResult extends CharacterGrowthCommandResult {
    readonly replayed: boolean
    readonly playerBondTokenBefore: number
    readonly playerBondTokenAfter: number
}

function observed(
    character: CharacterGrowthCoreFact,
    bondTokens: ReadonlyMap<number, BondTokenStatus>,
): CharacterGrowthObservedState {
    return {
        ...character,
        bondTokens,
    }
}

function validateCommand(command: ReceiveBondTokenCommand): void {
    if (!Number.isSafeInteger(command.playerId) || command.playerId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "characterId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.manaBoardIndex) || command.manaBoardIndex <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "manaBoardIndex must be a positive safe integer.")
    }
    if (!(command.evaluationTime instanceof Date) || !Number.isFinite(command.evaluationTime.getTime())) {
        throw growthError("INVALID_GROWTH_STATE", "evaluationTime must be a valid Date.")
    }
}

export function receiveBondToken(
    command: ReceiveBondTokenCommand,
): ReceiveBondTokenResult {
    validateCommand(command)
    const db = getDb()
    return db.transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const character = context.character()
        const currentTokens = context.bondTokens()
        const currentStatus = getBondTokenStatus(currentTokens, command.manaBoardIndex)
        if (currentStatus === null || currentStatus === 0) {
            throw growthError(
                "BOND_TOKEN_NOT_EARNED",
                `bond token for board ${command.manaBoardIndex} has not been earned.`,
            )
        }

        const player = getPlayerSync(command.playerId)
        if (player === null) {
            throw growthError("INVALID_GROWTH_STATE", `player ${command.playerId} is unavailable.`)
        }

        const before = observed(character, currentTokens)
        if (currentStatus === 2) {
            return {
                command: "receive_bond_token",
                before,
                after: before,
                changedNodeIds: [],
                replayed: true,
                playerBondTokenBefore: player.bondToken,
                playerBondTokenAfter: player.bondToken,
            }
        }

        const nextBondToken = player.bondToken + 1
        updatePlayerSync({ id: command.playerId, bondToken: nextBondToken })
        updatePlayerCharacterBondTokenSync(command.playerId, command.characterId, {
            manaBoardIndex: command.manaBoardIndex,
            status: 2,
        })

        const afterTokens = new Map(currentTokens)
        afterTokens.set(command.manaBoardIndex, 2)
        return {
            command: "receive_bond_token",
            before,
            after: observed(character, afterTokens),
            changedNodeIds: [],
            replayed: false,
            playerBondTokenBefore: player.bondToken,
            playerBondTokenAfter: nextBondToken,
        }
    })()
}

export const executeReceiveBondToken = receiveBondToken
