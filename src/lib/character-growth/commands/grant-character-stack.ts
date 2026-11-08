import { getDb } from "../../../data/db"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import type { PlayerCharacter } from "../../../data/types"
import { getCharacterFacts } from "../../character-content"
import { withInventoryBatchContextWithinTransactionSync } from "../../inventory"
import type { Element, GivePlayerCharacterResult } from "../../types"
import { createRewardGrantItemOverflowPolicy } from "../../reward-grant-item-overflow"
import { settleDirectItemOverflowsWithinTransactionSync } from "../../item-overflow"
import {
    CHARACTER_STACK_CONVERSION_EXP,
    CHARACTER_STACK_CONVERSION_ITEM,
    CHARACTER_STACK_MAX,
    STACK_CONVERSION_REWARD_ITEM_ID,
} from "../limits"
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

const duplicateCompensationCountByRarity: Readonly<Record<number, number>> = Object.freeze({
    3: 1,
    4: 1,
    5: 3,
})

export interface CharacterStackCompensation {
    readonly id: number
    readonly count: number
}

export function getCharacterStackCompensationItemId(
    rarity: number,
    element: Element,
): number | undefined {
    return duplicateItemByRarityAndElement[rarity]?.[element]
}

export function getCharacterStackCompensation(
    rarity: number,
    element: Element,
): CharacterStackCompensation | undefined {
    const id = getCharacterStackCompensationItemId(rarity, element)
    const count = duplicateCompensationCountByRarity[rarity]
    if (id === undefined || count === undefined) return undefined
    return { id, count }
}

export interface GrantCharacterStackCommand {
    readonly playerId: number
    readonly characterId: number
}

export interface CharacterStackOverflowConversion {
    readonly exp: number
    readonly grainItemId: number
    readonly grainCount: number
}

/** 溢出重复的转换口径:与手动重复转换同表(exp+星之粒,按稀有度)。 */
export function getCharacterStackOverflowConversion(rarity: number): CharacterStackOverflowConversion | undefined {
    const exp = CHARACTER_STACK_CONVERSION_EXP[rarity]
    const grainCount = CHARACTER_STACK_CONVERSION_ITEM[rarity]
    if (exp === undefined || grainCount === undefined) return undefined
    return { exp, grainItemId: STACK_CONVERSION_REWARD_ITEM_ID, grainCount }
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
    const asset = getCharacterFacts().get(command.characterId)
    if (asset === null) return null
    if (character.stack >= CHARACTER_STACK_MAX) {
        // 官方语义(帮助 L67):重复数达 99 后,超出部分的角色自动转换为
        // 经验值——本体保持 99 不变,按稀有度折 exp+星之粒;元素结晶
        // (突破材料)不再发放(溢出重复已无突破用途)。
        return convertOverflowDuplicateWithinTransactionSync(command, character, asset, grantCompensation)
    }
    const compensation = getCharacterStackCompensation(asset.rarity, asset.element as Element)
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
            ...(compensation === undefined ? {} : {
                item: { id: compensation.id, count: compensation.count },
            }),
        }
    }

    if (compensation === undefined) return updateStack()
    if (grantCompensation !== undefined) {
        grantCompensation(command.playerId, compensation.id, compensation.count)
        return updateStack()
    }
    return withInventoryBatchContextWithinTransactionSync({
        playerId: command.playerId,
        preloadItemIds: [compensation.id],
    }, inventory => {
        const overflowPolicy = createRewardGrantItemOverflowPolicy(command.playerId)
        const grant = inventory.grantWithCapacity(
            compensation.id,
            compensation.count,
            overflowPolicy.maxCount(compensation.id),
        )
        inventory.flush()
        const overflowSettlement = grant.overflowAmount > 0
            ? settleDirectItemOverflowsWithinTransactionSync({
                playerId: command.playerId,
                overflows: [{ itemId: compensation.id, amount: grant.overflowAmount }],
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

function convertOverflowDuplicateWithinTransactionSync(
    command: GrantCharacterStackCommand,
    character: PlayerCharacter,
    asset: { rarity: number },
    grantCompensation?: CharacterStackCompensationGrant,
): GivePlayerCharacterResult {
    const conversion = getCharacterStackOverflowConversion(asset.rarity)
    if (conversion === undefined) throw new Error(`character rarity ${asset.rarity} cannot convert stack.`)
    const player = getPlayerSync(command.playerId)
    if (player === null) throw new Error("character stack player disappeared")
    const afterPool = addSafeInteger(player.expPool, conversion.exp, "player.expPool")
    updatePlayerSync({ id: command.playerId, expPool: afterPool })
    const projected = projectCharacterGrowthEntry({
        characterId: command.characterId,
        character,
        state: characterGrowthProjectionStateFromPlayerCharacter(command.characterId, character),
        fields: STACK_CHARACTER_GROWTH_FIELDS,
    })
    if (grantCompensation !== undefined) {
        // 引擎路径(扭蛋/邮件/任务 RewardGrant):星之粒必须经
        // grantCompensation 回调真实入账——引擎不变式要求 result.item 与
        // Inventory 变动一一对应,只挂 item 不入账会整单回滚(双审 P1)
        grantCompensation(command.playerId, conversion.grainItemId, conversion.grainCount)
        return {
            isNew: false,
            character: projected,
            item: { id: conversion.grainItemId, count: conversion.grainCount },
        }
    }
    return withInventoryBatchContextWithinTransactionSync({
        playerId: command.playerId,
        preloadItemIds: [conversion.grainItemId],
    }, inventory => {
        const overflowPolicy = createRewardGrantItemOverflowPolicy(command.playerId)
        const grant = inventory.grantWithCapacity(
            conversion.grainItemId,
            conversion.grainCount,
            overflowPolicy.maxCount(conversion.grainItemId),
        )
        inventory.flush()
        const overflowSettlement = grant.overflowAmount > 0
            ? settleDirectItemOverflowsWithinTransactionSync({
                playerId: command.playerId,
                overflows: [{ itemId: conversion.grainItemId, amount: grant.overflowAmount }],
            })
            : null
        return {
            isNew: false,
            character: projected,
            item: { id: conversion.grainItemId, count: conversion.grainCount },
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
