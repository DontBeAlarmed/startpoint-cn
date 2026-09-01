import { getDb } from "../../../data/db"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import {
    givePlayerItemSync,
    givePlayerItemWithinTransactionSync,
} from "../../../data/domains/item"
import type { PlayerCharacter } from "../../../data/types"
import { getCharacterDataSync } from "../../assets"
import type { Element, GivePlayerCharacterResult } from "../../types"
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

/** Adds one duplicate-character stack; new ownership remains the character domain's job. */
export function grantCharacterStackWithinTransactionSync(
    command: GrantCharacterStackCommand,
    giveItem: typeof givePlayerItemWithinTransactionSync = givePlayerItemWithinTransactionSync,
    knownCharacter?: PlayerCharacter,
): GivePlayerCharacterResult | null {
    assertInsideTransaction()
    validateGrowthCommandIds(command.playerId, command.characterId)
    const character = knownCharacter ?? getPlayerCharacterSync(command.playerId, command.characterId)
    if (character === null) return null
    const asset = getCharacterDataSync(command.characterId)
    if (asset === null) return null
    const itemId = duplicateItemByRarityAndElement[asset.rarity]?.[asset.element as Element]
    if (itemId !== undefined) giveItem(command.playerId, itemId, 1)
    const stack = addSafeInteger(character.stack, 1, "character.stack")
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

export function grantCharacterStack(command: GrantCharacterStackCommand): GivePlayerCharacterResult | null {
    return getDb().transaction(() => grantCharacterStackWithinTransactionSync(
        command,
        (playerId, itemId, amount) => givePlayerItemSync(playerId, itemId, amount),
    ))()
}

export const executeGrantCharacterStack = grantCharacterStack
