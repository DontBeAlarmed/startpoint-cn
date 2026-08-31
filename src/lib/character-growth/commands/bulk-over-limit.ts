import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { getPlayerCharactersSync } from "../../../data/domains/character"
import { getCharacterDataSync } from "../../assets"
import { createCharacterGrowthBatchContext } from "../batch-context"
import { growthError } from "../errors"
import { characterMaxOverLimits } from "../limits"
import {
    observedCore,
    updateCharacterGrowthRowsSync,
    validateEvaluationTime,
    validateGrowthPlayerId,
} from "../mutation-support"

export interface BulkOverLimitCommand {
    readonly playerId: number
    readonly evaluationTime: Date
}

export interface BulkOverLimitResult {
    readonly command: "bulk_over_limit"
    readonly characters: readonly ReturnType<typeof observedCore>[]
    readonly replayed: false
}

export function executeBulkOverLimit(command: BulkOverLimitCommand): BulkOverLimitResult {
    validateGrowthPlayerId(command.playerId)
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        if (getPlayerSync(command.playerId) === null) {
            throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        }
        const stored = getPlayerCharactersSync(command.playerId)
        const ids = Object.keys(stored).map(Number)
        const context = createCharacterGrowthBatchContext({ playerId: command.playerId, characterIds: ids })
        const updates: { characterId: number; overLimitStep: number; stack: number }[] = []
        for (const character of context.characters().values()) {
            const asset = getCharacterDataSync(character.characterId)
            const max = asset === null ? undefined : characterMaxOverLimits[asset.rarity]
            if (max === undefined || character.stack <= 0 || character.overLimitStep >= max) continue
            const count = Math.min(character.stack, max - character.overLimitStep)
            updates.push({
                characterId: character.characterId,
                overLimitStep: character.overLimitStep + count,
                stack: character.stack - count,
            })
        }
        updateCharacterGrowthRowsSync(command.playerId, updates)
        return {
            command: "bulk_over_limit",
            characters: updates.map(update => observedCore(
                context.character(update.characterId)!,
                { overLimitStep: update.overLimitStep, stack: update.stack },
            )),
            replayed: false,
        } as BulkOverLimitResult
    })()
}

export const bulkOverLimit = executeBulkOverLimit
