import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { getPlayerCharacterGrowthSeedsSync } from "../../../data/domains/character"
import type { PlayerCharacterProjectionData } from "../../../data/types"
import { createCharacterGrowthBatchContext } from "../batch-context"
import { growthError } from "../errors"
import { characterMaxOverLimits } from "../limits"
import {
    characterGrowthStoredCoreFromRaw,
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
    readonly projectionCharacters: Readonly<Record<string, PlayerCharacterProjectionData>>
    readonly replayed: false
}

export function executeBulkOverLimit(command: BulkOverLimitCommand): BulkOverLimitResult {
    validateGrowthPlayerId(command.playerId)
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        if (getPlayerSync(command.playerId) === null) {
            throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        }
        const seeds = getPlayerCharacterGrowthSeedsSync(command.playerId)
        const ids = Object.keys(seeds).map(Number)
        const context = createCharacterGrowthBatchContext({
            playerId: command.playerId,
            characterIds: ids,
            storedCharactersSnapshot: Object.fromEntries(Object.entries(seeds).map(([id, seed]) => [
                id,
                characterGrowthStoredCoreFromRaw(seed.storedGrowth),
            ])),
        })
        const updates: { characterId: number; overLimitStep: number; stack: number }[] = []
        for (const character of context.characters().values()) {
            const max = characterMaxOverLimits[character.rarity]
            if (max === undefined || character.stack <= 0 || character.overLimitStep >= max) continue
            const count = Math.min(character.stack, max - character.overLimitStep)
            updates.push({
                characterId: character.characterId,
                overLimitStep: character.overLimitStep + count,
                stack: character.stack - count,
            })
        }
        const updateTime = updateCharacterGrowthRowsSync(command.playerId, updates)
        const characters = updates.map(update => observedCore(
            context.character(update.characterId)!,
            { overLimitStep: update.overLimitStep, stack: update.stack },
        ))
        return {
            command: "bulk_over_limit",
            characters,
            projectionCharacters: Object.fromEntries(characters.map(character => {
                const projection = seeds[String(character.characterId)]?.projection
                if (projection === undefined || updateTime === null) {
                    throw growthError("INVALID_GROWTH_STATE", "bulk Growth projection metadata is unavailable.")
                }
                return [String(character.characterId), { ...projection, updateTime }]
            })),
            replayed: false,
        } as BulkOverLimitResult
    })()
}

export const bulkOverLimit = executeBulkOverLimit
