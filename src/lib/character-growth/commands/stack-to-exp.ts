import { getDb } from "../../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import {
    getPlayerItemSync,
    recordPlayerCollectedItemWithinTransactionSync,
    setPlayerItemWithinTransactionSync,
} from "../../../data/domains/item"
import { createCharacterGrowthRequestContext } from "../request-context"
import { growthError } from "../errors"
import { validateCharacterStackConversion } from "../../character-stack"
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
    validateGrowthCommandIds,
    validatePositiveAmount,
} from "../mutation-support"

export interface StackToExpCommand {
    readonly playerId: number
    readonly characterId: number
    readonly useStackCount: number
    readonly evaluationTime: Date
}

export interface StackToExpResult {
    readonly command: "stack_to_exp"
    readonly before: ReturnType<typeof observedCore>
    readonly after: ReturnType<typeof observedCore>
    readonly addExp: number
    readonly addStarGrain: number
    readonly expPool: number
    readonly itemCount: number
    readonly replayed: false
}

export function executeStackToExp(command: StackToExpCommand): StackToExpResult {
    validateGrowthCommandIds(command.playerId, command.characterId)
    validatePositiveAmount(command.useStackCount, "useStackCount")
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const before = context.character()
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        const validationError = validateCharacterStackConversion(
            before.stack,
            command.useStackCount,
            before.protection,
        )
        if (validationError) throw growthError("INVALID_REQUEST", validationError)
        const expPerStack = CHARACTER_STACK_CONVERSION_EXP[before.rarity]
        const itemPerStack = CHARACTER_STACK_CONVERSION_ITEM[before.rarity]
        if (expPerStack === undefined || itemPerStack === undefined) {
            throw growthError("CONTENT_INVALID", `character rarity ${before.rarity} cannot convert stack.`)
        }
        const addExp = expPerStack * command.useStackCount
        const addStarGrain = itemPerStack * command.useStackCount
        const afterPool = addSafeInteger(player.expPool, addExp, "player.expPool")
        const existingItem = getPlayerItemSync(command.playerId, STACK_CONVERSION_REWARD_ITEM_ID)
        const afterItem = addSafeInteger(existingItem ?? 0, addStarGrain, "item.amount")
        updateCharacterGrowthRowsSync(command.playerId, [{
            characterId: command.characterId,
            stack: before.stack - command.useStackCount,
        }])
        updatePlayerSync({ id: command.playerId, expPool: afterPool })
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
        return {
            command: "stack_to_exp",
            before,
            after: observedCore(before, { stack: before.stack - command.useStackCount }),
            addExp,
            addStarGrain,
            expPool: afterPool,
            itemCount: afterItem,
            replayed: false,
        } as StackToExpResult
    })()
}

export const stackToExp = executeStackToExp
