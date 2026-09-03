import { getDb } from "../../../data/db"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import type { PlayerCharacter } from "../../../data/types"
import { getCharacterDataSync } from "../../assets"
import { withInventoryBatchContextWithinTransactionSync } from "../../inventory"
import type { Element, GivePlayerCharacterResult } from "../../types"
import { createRewardGrantItemOverflowPolicy } from "../../reward-grant-item-overflow"
import { settleDirectItemOverflowsWithinTransactionSync } from "../../item-overflow"
import { addSafeInteger, assertInsideTransaction, updateCharacterGrowthRowsSync, validateGrowthCommandIds } from "../mutation-support"
import {
    STACK_CHARACTER_GROWTH_FIELDS,
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} from "../response-projector"

const duplicateItemByRarityAndElement: Readonly<Record<number, Readonly<Record<number, number>>>> = Object.freeze({
    3: { 0: 14001, 1: 14004, 2: 14007, 3: 14010, 4: 14016, 5: 14013 },
    4: { 0: 14002, 1: 14005, 2: 14008, 3: 14011, 4: 14017, 5: 14014 },
    5: { 0: 14003, 1: 14006, 2: 14009, 3: 14012, 4: 14018, 5: 14015 },
})

export interface GrantCharacterStackCommand {
    readonly playerId: number
    readonly characterId: number
}

export type CharacterStackCompensationGrant = (
    playerId: number,
    itemId: number,
    amount: number,
) => void

/** Adds one duplicate-character stack; new ownership remains the character domain's job. */
export function grantCharacterStackWithinTransactionSync(
    command: GrantCharacterStackCommand,
    grantCompensation?: CharacterStackCompensationGrant,
    knownCharacter?: PlayerCharacter,
): GivePlayerCharacterResult | null {
    assertInsideTransaction()
    validateGrowthCommandIds(command.playerId, command.characterId)
    const character = knownCharacter ?? getPlayerCharacterSync(command.playerId, command.characterId)
    if (character === null) return null
    const asset = getCharacterDataSync(command.characterId)
    if (asset === null) return null
    const itemId = duplicateItemByRarityAndElement[asset.rarity]?.[asset.element as Element]
    const stack = addSafeInteger(character.stack, 1, "character.stack")

    const updateStack = (): GivePlayerCharacterResult => {
        const updateTime = updateCharacterGrowthRowsSync(command.playerId, [{
            characterId: command.characterId,
            stack,
        }])
        if (updateTime === null) throw new Error("character stack update did not write")
        const afterCharacter: PlayerCharacter = { ...character, stack, updateTime }
        return {
            isNew: false,
            character: projectCharacterGrowthEntry({
                characterId: command.characterId,
                character: afterCharacter,
                state: characterGrowthProjectionStateFromPlayerCharacter(command.characterId, afterCharacter),
                fields: STACK_CHARACTER_GROWTH_FIELDS,
            }),
            ...(itemId === undefined ? {} : { item: { id: itemId, count: 1 } }),
        }
    }

    if (itemId === undefined) return updateStack()
    if (grantCompensation !== undefined) {
        grantCompensation(command.playerId, itemId, 1)
        return updateStack()
    }
    return withInventoryBatchContextWithinTransactionSync({
        playerId: command.playerId,
        preloadItemIds: [itemId],
    }, inventory => {
        const overflowPolicy = createRewardGrantItemOverflowPolicy(command.playerId)
        const grant = inventory.grantWithCapacity(itemId, 1, overflowPolicy.maxCount(itemId))
        inventory.flush()
        const overflowSettlement = grant.overflowAmount > 0
            ? settleDirectItemOverflowsWithinTransactionSync({
                playerId: command.playerId,
                overflows: [{ itemId, amount: grant.overflowAmount }],
            })
            : null
        return {
            ...updateStack(),
            itemAfterAmount: grant.afterAmount,
            ...(overflowSettlement === null ? {} : {
                itemOverflowDispositions: overflowSettlement.dispositions,
                overflowFreeManaAfter: overflowSettlement.freeManaAfter,
            }),
        }
    })
}

export function grantCharacterStack(command: GrantCharacterStackCommand): GivePlayerCharacterResult | null {
    return getDb().transaction(() => grantCharacterStackWithinTransactionSync(command))()
}

export const executeGrantCharacterStack = grantCharacterStack
