import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { getPlayerItemSync, setPlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { createCharacterGrowthRequestContext } from "../request-context"
import { growthError } from "../errors"
import { characterMaxOverLimits, OVER_LIMIT_ITEM_BY_RARITY } from "../limits"
import {
    observedCore,
    updateCharacterGrowthRowsSync,
    validateEvaluationTime,
    validateGrowthCommandIds,
    validatePositiveAmount,
} from "../mutation-support"

export interface OverLimitCommand {
    readonly playerId: number
    readonly characterId: number
    readonly overLimitCount: number
    readonly useStack: boolean
    readonly itemId?: number
    readonly evaluationTime: Date
}

export interface OverLimitResult {
    readonly command: "over_limit"
    readonly before: ReturnType<typeof observedCore>
    readonly after: ReturnType<typeof observedCore>
    readonly itemId?: number
    readonly itemCount?: number
    readonly replayed: false
}

function validateItemId(rarity: number, itemId: number | undefined): number {
    if (itemId === undefined) throw growthError("INVALID_REQUEST", "itemId is required when useStack is false.")
    if (rarity === 5 && itemId !== 10003) {
        throw growthError("INVALID_REQUEST", "invalid item for a 5-star character.")
    }
    if (rarity <= 4 && itemId !== 10001 && itemId !== 10002) {
        throw growthError("INVALID_REQUEST", "invalid item for this character rarity.")
    }
    return itemId
}

export function executeOverLimit(command: OverLimitCommand): OverLimitResult {
    validateGrowthCommandIds(command.playerId, command.characterId)
    validatePositiveAmount(command.overLimitCount, "overLimitCount")
    if (typeof command.useStack !== "boolean") {
        throw growthError("INVALID_REQUEST", "useStack must be a boolean.")
    }
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const before = context.character()
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        const max = characterMaxOverLimits[before.rarity]
        if (max === undefined || before.overLimitStep + command.overLimitCount > max) {
            throw growthError("INVALID_REQUEST", "character cannot be uncapped further.")
        }
        const nextOverLimit = before.overLimitStep + command.overLimitCount
        if (command.useStack) {
            if (before.stack < command.overLimitCount) {
                throw growthError("INVALID_REQUEST", "character does not have enough duplicates to uncap.")
            }
            updateCharacterGrowthRowsSync(command.playerId, [{
                characterId: command.characterId,
                overLimitStep: nextOverLimit,
                stack: before.stack - command.overLimitCount,
            }])
            return {
                command: "over_limit",
                before,
                after: observedCore(before, {
                    overLimitStep: nextOverLimit,
                    stack: before.stack - command.overLimitCount,
                }),
                replayed: false,
            } as OverLimitResult
        }
        const itemId = validateItemId(before.rarity, command.itemId)
        const currentItem = getPlayerItemSync(command.playerId, itemId)
        const afterItem = (currentItem ?? 0) - command.overLimitCount
        if (afterItem < 0) throw growthError("INSUFFICIENT_ITEM", `player does not have enough item ${itemId}.`)
        setPlayerItemWithinTransactionSync(command.playerId, itemId, afterItem, currentItem !== null)
        updateCharacterGrowthRowsSync(command.playerId, [{
            characterId: command.characterId,
            overLimitStep: nextOverLimit,
        }])
        return {
            command: "over_limit",
            before,
            after: observedCore(before, { overLimitStep: nextOverLimit }),
            itemId,
            itemCount: afterItem,
            replayed: false,
        } as OverLimitResult
    })()
}

export const overLimit = executeOverLimit
