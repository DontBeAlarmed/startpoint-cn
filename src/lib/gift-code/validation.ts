import bundledCharacterData from "../../../assets/character.json"
import bundledItemMaxCounts from "../../../assets/item_max_count.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import { getEquipmentIdsSync, getItemIdsSync } from "../assets"
import { RewardType } from "../types/rewards"
import type { GiftDraft, GiftProtocolType, GiftReward } from "./types"

export const GIFT_MAX_REWARDS = 20
export const GIFT_MAX_INT = 2147483647
export const GIFT_MAX_NOTE_LENGTH = 512

export const GIFT_TO_REWARD_TYPE = {
    1: RewardType.ITEM,
    4: RewardType.BEADS,
    5: RewardType.CHARACTER,
    6: RewardType.EQUIPMENT,
    8: RewardType.MANA,
    9: RewardType.EXP,
} as const satisfies Record<GiftProtocolType, RewardType>

export class GiftCodeValidationError extends Error {
    constructor() {
        super("Gift code validation failed")
        this.name = "GiftCodeValidationError"
    }
}

export class GiftDraftValidationError extends Error {
    constructor() {
        super("Gift draft validation failed")
        this.name = "GiftDraftValidationError"
    }
}

export class GiftRewardValidationError extends Error {
    constructor() {
        super("Gift reward validation failed")
        this.name = "GiftRewardValidationError"
    }
}

export function validateGiftCode(code: string): void {
    if (
        typeof code !== "string"
        || code.length < 1
        || code.length > 20
        || code.includes("\r")
        || code.includes("\n")
    ) {
        throw new GiftCodeValidationError()
    }
}

function isValidCharacterId(characterId: number): boolean {
    const table = getRuntimeContentTableSync(
        "character.json",
        bundledCharacterData as Record<string, unknown>,
    )
    return Object.prototype.hasOwnProperty.call(table, String(characterId))
}

function isGiftProtocolType(value: unknown): value is GiftProtocolType {
    return value === 1 || value === 4 || value === 5
        || value === 6 || value === 8 || value === 9
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function requireExactObject(
    value: unknown,
    expectedKeys: readonly string[],
): Record<string, unknown> {
    if (!isPlainObject(value)) throw new GiftDraftValidationError()
    const actualKeys = Reflect.ownKeys(value)
    if (actualKeys.length !== expectedKeys.length
        || actualKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) {
        throw new GiftDraftValidationError()
    }
    return value
}

function requireId(typeId: unknown, exists: (id: number) => boolean): number {
    if (typeof typeId !== "number" || !Number.isSafeInteger(typeId) || typeId <= 0 || !exists(typeId)) {
        throw new GiftRewardValidationError()
    }
    return typeId
}

function validateReward(reward: GiftReward, position: number): void {
    if (reward === null || typeof reward !== "object") {
        throw new GiftRewardValidationError()
    }
    if (reward.position !== position || !Number.isSafeInteger(reward.position)) {
        throw new GiftRewardValidationError()
    }
    if (!isGiftProtocolType(reward.type)) {
        throw new GiftRewardValidationError()
    }

    if (reward.type === 1) {
        requireId(reward.typeId, itemId => getItemIdsSync().includes(itemId))
    } else if (reward.type === 5) {
        requireId(reward.typeId, isValidCharacterId)
    } else if (reward.type === 6) {
        requireId(reward.typeId, equipmentId => getEquipmentIdsSync().includes(equipmentId))
    } else if (reward.typeId !== null) {
        throw new GiftRewardValidationError()
    }

    if (typeof reward.number !== "number"
        || !Number.isSafeInteger(reward.number)
        || reward.number <= 0
        || reward.number > GIFT_MAX_INT) {
        throw new GiftRewardValidationError()
    }
    if (reward.type === 5 || reward.type === 6) {
        if (reward.number !== 1) throw new GiftRewardValidationError()
        return
    }
    if (reward.type === 1) {
        const maxCounts = getRuntimeContentTableSync(
            "item_max_count.json",
            bundledItemMaxCounts as Record<string, number>,
        )
        const maxCount = maxCounts[String(reward.typeId)]
        if (typeof maxCount !== "number"
            || !Number.isSafeInteger(maxCount)
            || maxCount <= 0
            || reward.number > maxCount) {
            throw new GiftRewardValidationError()
        }
    }
}

export function validateGiftRewards(rewards: readonly GiftReward[]): readonly GiftReward[] {
    if (!Array.isArray(rewards) || rewards.length < 1 || rewards.length > GIFT_MAX_REWARDS) {
        throw new GiftRewardValidationError()
    }
    for (let position = 0; position < rewards.length; position += 1) {
        if (!Object.prototype.hasOwnProperty.call(rewards, position)) {
            throw new GiftRewardValidationError()
        }
        validateReward(rewards[position] as GiftReward, position)
    }
    return rewards
}

export function validateGiftDraft(input: unknown): GiftDraft {
    const record = requireExactObject(input, ["code", "note", "rewards"])
    const rawNote = record.note
    if (rawNote !== null && (typeof rawNote !== "string" || rawNote.length > GIFT_MAX_NOTE_LENGTH)) {
        throw new GiftDraftValidationError()
    }
    validateGiftCode(record.code as string)

    const rawRewards = record.rewards
    if (!Array.isArray(rawRewards)
        || rawRewards.length < 1
        || rawRewards.length > GIFT_MAX_REWARDS) {
        throw new GiftDraftValidationError()
    }
    const rewards: GiftReward[] = []
    for (let position = 0; position < rawRewards.length; position += 1) {
        if (!Object.prototype.hasOwnProperty.call(rawRewards, position)) {
            throw new GiftDraftValidationError()
        }
        const rawReward = requireExactObject(
            rawRewards[position],
            ["position", "type", "typeId", "number"],
        )
        rewards.push(Object.freeze({
            position: rawReward.position,
            type: rawReward.type,
            typeId: rawReward.typeId,
            number: rawReward.number,
        }) as GiftReward)
    }

    const draft: GiftDraft = Object.freeze({
        code: record.code as string,
        note: rawNote as string | null,
        rewards: Object.freeze(rewards),
    })
    validateGiftRewards(draft.rewards)
    return draft
}
