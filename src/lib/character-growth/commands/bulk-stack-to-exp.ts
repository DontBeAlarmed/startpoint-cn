import { getDb } from "../../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { getPlayerCharactersSync } from "../../../data/domains/character"
import {
    getPlayerItemSync,
    recordPlayerCollectedItemWithinTransactionSync,
    setPlayerItemWithinTransactionSync,
} from "../../../data/domains/item"
import { getCharacterDataSync } from "../../assets"
import { createCharacterGrowthBatchContext } from "../batch-context"
import { growthError } from "../errors"
import {
    CHARACTER_STACK_CONVERSION_EXP,
    CHARACTER_STACK_CONVERSION_ITEM,
    STACK_CONVERSION_REWARD_ITEM_ID,
} from "../limits"
import {
    addSafeInteger,
    observedCore,
    updateCharacterGrowthRowsSync,
    validateEvaluationTime,
    validateGrowthPlayerId,
} from "../mutation-support"

export interface BulkStackToExpCommand {
    readonly playerId: number
    readonly evaluationTime: Date
}

export interface BulkStackToExpResult {
    readonly command: "bulk_stack_to_exp"
    readonly characters: readonly ReturnType<typeof observedCore>[]
    readonly addExp: number
    readonly addStarGrain: number
    readonly expPool: number
    readonly itemCount: number
    readonly replayed: false
}

export function executeBulkStackToExp(command: BulkStackToExpCommand): BulkStackToExpResult {
    validateGrowthPlayerId(command.playerId)
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        const storedCharacters = getPlayerCharactersSync(command.playerId)
        const characterIds = Object.keys(storedCharacters).map(Number)
        const context = createCharacterGrowthBatchContext({
            playerId: command.playerId,
            characterIds,
        })
        const selected: ReturnType<typeof observedCore>[] = []
        let addExp = 0
        let addStarGrain = 0
        for (const character of context.characters().values()) {
            const asset = getCharacterDataSync(character.characterId)
            const maxOverLimit = asset === null ? undefined : ({
                1: 12, 2: 10, 3: 8, 4: 6, 5: 4,
            } as Record<number, number>)[asset.rarity]
            if (asset === null || maxOverLimit === undefined
                || character.protection || character.stack <= 0
                || character.overLimitStep < maxOverLimit) continue
            const expPerStack = CHARACTER_STACK_CONVERSION_EXP[character.rarity]
            const itemPerStack = CHARACTER_STACK_CONVERSION_ITEM[character.rarity]
            if (expPerStack === undefined || itemPerStack === undefined) {
                throw growthError("CONTENT_INVALID", `character rarity ${character.rarity} cannot convert stack.`)
            }
            addExp = addSafeInteger(addExp, expPerStack * character.stack, "player.expPool")
            addStarGrain = addSafeInteger(addStarGrain, itemPerStack * character.stack, "item.amount")
            selected.push(observedCore(character, { stack: 0 }))
        }
        const afterPool = addSafeInteger(player.expPool, addExp, "player.expPool")
        const existingItem = getPlayerItemSync(command.playerId, STACK_CONVERSION_REWARD_ITEM_ID)
        const currentItem = existingItem ?? 0
        const afterItem = addSafeInteger(currentItem, addStarGrain, "item.amount")
        updateCharacterGrowthRowsSync(command.playerId, selected.map(character => ({
            characterId: character.characterId,
            stack: 0,
        })))
        updatePlayerSync({ id: command.playerId, expPool: afterPool })
        if (addStarGrain > 0) {
            setPlayerItemWithinTransactionSync(
                command.playerId,
                STACK_CONVERSION_REWARD_ITEM_ID,
                afterItem,
                existingItem !== null,
            )
            recordPlayerCollectedItemWithinTransactionSync(
                command.playerId,
                STACK_CONVERSION_REWARD_ITEM_ID,
                addStarGrain,
            )
        }
        return {
            command: "bulk_stack_to_exp",
            characters: selected,
            addExp,
            addStarGrain,
            expPool: afterPool,
            itemCount: afterItem,
            replayed: false,
        } as BulkStackToExpResult
    })()
}

export const bulkStackToExp = executeBulkStackToExp
