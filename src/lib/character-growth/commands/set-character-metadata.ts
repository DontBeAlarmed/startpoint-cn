import { getDb } from "../../../data/db"
import { getPlayerCharacterSync, updatePlayerCharacterSync } from "../../../data/domains/character"
import type { PlayerCharacter } from "../../../data/types"
import { growthError } from "../errors"

export interface SetCharacterProtectionCommand {
    readonly playerId: number
    readonly characterIds: readonly number[]
    readonly protection: boolean
}

export interface UpdatedCharacterRow {
    readonly characterId: number
    readonly character: PlayerCharacter
}

export interface SetCharacterIllustrationSettingsCommand {
    readonly playerId: number
    readonly characterId: number
    readonly illustrationSettings: readonly number[]
}

function validateGrowthPlayerId(playerId: number): void {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw growthError("INVALID_REQUEST", "playerId must be a positive safe integer.")
    }
}

function validateIllustrationSettings(settings: readonly number[]): void {
    if (settings.length !== 6
        || settings.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw growthError("INVALID_REQUEST", "illustration settings must be six non-negative integers.")
    }
}

/**
 * Batch protection toggle. Character ids the player does not own are skipped
 * without failing the batch (transport-level behavior kept from the route).
 */
export function setCharacterProtection(
    command: SetCharacterProtectionCommand,
): readonly UpdatedCharacterRow[] {
    validateGrowthPlayerId(command.playerId)
    const characterIds = [...new Set(command.characterIds)]
        .filter(characterId => Number.isSafeInteger(characterId) && characterId > 0)
    return getDb().transaction(() => {
        const updated: UpdatedCharacterRow[] = []
        for (const characterId of characterIds) {
            if (getPlayerCharacterSync(command.playerId, characterId) === null) continue
            updatePlayerCharacterSync(command.playerId, characterId, {
                protection: command.protection,
            })
            const after = getPlayerCharacterSync(command.playerId, characterId)
            if (after !== null) updated.push({ characterId, character: after })
        }
        return updated
    })()
}

export function setCharacterIllustrationSettings(
    command: SetCharacterIllustrationSettingsCommand,
): void {
    validateGrowthPlayerId(command.playerId)
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_REQUEST", "characterId must be a positive safe integer.")
    }
    validateIllustrationSettings(command.illustrationSettings)
    getDb().transaction(() => {
        if (getPlayerCharacterSync(command.playerId, command.characterId) === null) {
            throw growthError("CHARACTER_NOT_OWNED", `character ${command.characterId} is not owned.`)
        }
        updatePlayerCharacterSync(command.playerId, command.characterId, {
            illustrationSettings: [...command.illustrationSettings],
        })
    })()
}
