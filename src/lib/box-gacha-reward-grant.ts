import {
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import type { InventoryBatchContext } from "./inventory"
import type {
    BoxGachaDrawResult,
    PlayerRewardResult,
} from "./types"
import { RewardType } from "./types"

export interface BoxGachaRewardKnownPlayerState {
    readonly id: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface BoxGachaRewardGrantResult {
    readonly rewardResult: PlayerRewardResult
    readonly playerAfter: Omit<BoxGachaRewardKnownPlayerState, "id">
}

function createBoxGachaRewardPlan(
    drawResult: BoxGachaDrawResult,
): RewardGrantExecutionPlan {
    const entries: RewardGrantCommand[] = []

    for (const [itemId, count] of drawResult.items) {
        entries.push({ type: RewardType.ITEM, id: itemId, count })
    }
    for (const [equipmentId, count] of drawResult.equipment) {
        entries.push({ type: RewardType.EQUIPMENT, id: equipmentId, count })
    }
    for (const [characterId, count] of drawResult.characters) {
        for (let index = 0; index < count; index++) {
            entries.push({ type: RewardType.CHARACTER, id: characterId })
        }
    }
    if (drawResult.exp > 0) {
        entries.push({ type: RewardType.EXP, count: drawResult.exp })
    }
    if (drawResult.mana > 0) {
        entries.push({ type: RewardType.MANA, count: drawResult.mana })
    }
    return createRewardGrantExecutionPlan(entries)
}

function projectBoxGachaRewardResult(result: RewardGrantExecutionResult): PlayerRewardResult {
    const currency = Object.fromEntries(result.assets.currencies.map(entry => [
        entry.currency,
        entry.requestedAmount,
    ]))
    const items: Record<string, number> = {}
    for (const entry of result.entries) {
        if (entry.outcome.kind === "item") {
            items[String(entry.outcome.item.itemId)] = entry.outcome.item.afterAmount
        } else if (entry.outcome.kind === "character"
            && entry.outcome.compensationItem !== null) {
            const compensation = entry.outcome.compensationItem
            items[String(compensation.itemId)] = (items[String(compensation.itemId)] ?? 0)
                + compensation.acceptedAmount
        }
    }
    return {
        user_info: {
            free_mana: currency.freeMana ?? 0,
            free_vmoney: currency.freeVmoney ?? 0,
            exp_pool: currency.expPool ?? 0,
        },
        character_list: result.assets.characters.map(entry => entry.after),
        joined_character_id_list: [],
        equipment_list: result.assets.equipment.map(entry => entry.after),
        items,
    }
}

/**
 * Box Gacha remains the source transaction owner. This adapter only translates
 * a completed draw into RewardGrant entries and preserves the legacy Box
 * response projection while sharing the source-owned Inventory context.
 */
export function grantBoxGachaDrawInTransactionOwnerWithInventorySync(
    playerId: number,
    drawResult: BoxGachaDrawResult,
    knownPlayerBefore: BoxGachaRewardKnownPlayerState,
    inventory: InventoryBatchContext,
): BoxGachaRewardGrantResult {
    inventory.readMany([...drawResult.items.keys()])
    const plan = createBoxGachaRewardPlan(drawResult)
    const result = withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            playerId: knownPlayerBefore.id,
            freeMana: knownPlayerBefore.freeMana,
            freeVmoney: knownPlayerBefore.freeVmoney,
            expPool: knownPlayerBefore.expPool,
        },
        inventory,
        execution => {
            const validated = snapshotRewardGrantExecutionResultForPlan(
                playerId,
                plan,
                execution.result,
            )
            execution.finalize()
            return validated
        },
    )

    return {
        rewardResult: projectBoxGachaRewardResult(result),
        playerAfter: {
            freeMana: result.playerAfter.freeMana,
            freeVmoney: result.playerAfter.freeVmoney,
            expPool: result.playerAfter.expPool,
        },
    }
}
