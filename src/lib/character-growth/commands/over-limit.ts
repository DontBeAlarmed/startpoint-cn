import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { withInventoryBatchContextWithinTransactionSync } from "../../inventory"
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
import type { MissionSettlementResult } from "../../mission/settlement"
import { publishActiveMissionOwnerStateWithinTransaction } from "../../mission/active-publication-owner"
import { settleOverLimitMissions } from "../over-limit-mission-settlement"

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
    readonly missionSettlement: MissionSettlementResult | null
    readonly activeMissionList: readonly unknown[]
    readonly replayed: false
}

// 破星结晶适用规则(客户端 OwnedOverLimitLogic.as:126-128 同款):
// crystal.target == 角色稀有度,或 crystal.allow_below 且角色稀有度更低。
// CN 主数据(item.json col9/col11 + 描述):10001=★3(allow_below→≤3★)、
// 10002=★4(allow_below→≤4★,「可用于稀有度★4以下的角色」)、10003=★5
// (严格同稀有度)——帮助 Character_Strengthen L45「不同的破星结晶适用于
// 不同稀有度的角色」。旧实现 ≤4★ 混用 10001(★4 可被 ★3 结晶突破)已收紧。
const overLimitCrystalRules: Readonly<Record<number, {
    readonly targetRarity: number
    readonly allowsBelowRarity: boolean
}>> = Object.freeze({
    10001: { targetRarity: 3, allowsBelowRarity: true },
    10002: { targetRarity: 4, allowsBelowRarity: true },
    10003: { targetRarity: 5, allowsBelowRarity: false },
})

function validateItemId(rarity: number, itemId: number | undefined): number {
    if (itemId === undefined) throw growthError("INVALID_REQUEST", "itemId is required when useStack is false.")
    const rule = overLimitCrystalRules[itemId]
    const usable = rule !== undefined
        && (rarity === rule.targetRarity
            || (rule.allowsBelowRarity && rarity < rule.targetRarity))
    if (!usable) {
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
                missionSettlement: settleOverLimitMissions(command.playerId, command.evaluationTime),
                activeMissionList: publishActiveMissionOwnerStateWithinTransaction({
                    playerId: command.playerId,
                    now: command.evaluationTime,
                    source: "character-growth/over-limit",
                }).activeMissionList,
                replayed: false,
            } as OverLimitResult
        }
        const itemId = validateItemId(before.rarity, command.itemId)
        return withInventoryBatchContextWithinTransactionSync({
            playerId: command.playerId,
            preloadItemIds: [itemId],
        }, inventory => {
            const currentItem = inventory.read(itemId)
            if (currentItem.beforeAmount < command.overLimitCount) {
                throw growthError("INSUFFICIENT_ITEM", `player does not have enough item ${itemId}.`)
            }
            const itemResult = inventory.deduct(itemId, command.overLimitCount)
            inventory.flush()
            updateCharacterGrowthRowsSync(command.playerId, [{
                characterId: command.characterId,
                overLimitStep: nextOverLimit,
            }])
            return {
                command: "over_limit",
                before,
                after: observedCore(before, { overLimitStep: nextOverLimit }),
                itemId,
                itemCount: itemResult.afterAmount,
                missionSettlement: settleOverLimitMissions(command.playerId, command.evaluationTime),
                activeMissionList: publishActiveMissionOwnerStateWithinTransaction({
                    playerId: command.playerId,
                    now: command.evaluationTime,
                    source: "character-growth/over-limit",
                }).activeMissionList,
                replayed: false,
            } as OverLimitResult
        })
    })()
}

export const overLimit = executeOverLimit
