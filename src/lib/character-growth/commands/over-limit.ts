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
import { settleMissionCategories } from "../../mission/settlement"
import { getMissionCatalog } from "../../mission/mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES } from "../../mission/degree-context-requirements"
import type { MissionSettlementResult } from "../../mission/settlement"

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
    readonly replayed: false
}

// 上限突破是「各角色 overLimitStep 求和」状态事实的产生时点:任务 38 族
// (over_limit_total_count)与突破称号族(cat5 degree_overlimit_growth_,
// 状态族不在战斗 finish 的 degree 结算范围内)必须同事务窄域当场结算,
// 否则奖励被推迟到下次进关/任务页(2026-10-01 时点审计)。单次与批量
// 突破共用本结算面。
export function settleOverLimitMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const overLimitMissionIds = getMissionCatalog()
        .getDefinitionsByPattern("over_limit_total_count")
        .map(definition => definition.missionId)
    const degreeMissionIds = getMissionCatalog()
        .getDefinitions(5)
        .filter(definition => definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.overLimitCount))
        .map(definition => definition.missionId)
    return settleMissionCategories(
        playerId,
        [
            { category: 1, missionIds: overLimitMissionIds },
            { category: 5, missionIds: degreeMissionIds },
        ],
        evaluationTime,
    )
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
                missionSettlement: settleOverLimitMissions(command.playerId, command.evaluationTime),
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
                replayed: false,
            } as OverLimitResult
        })
    })()
}

export const overLimit = executeOverLimit
