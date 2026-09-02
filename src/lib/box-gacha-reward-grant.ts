import { createRewardGrantPlan } from "./reward-grant"
import {
    executeRewardGrantPlanInTransactionOwnerWithInventoryInternalSync,
} from "./reward-grant/owner-executor"
import type { InventoryBatchContext } from "./inventory"
import type {
    BoxGachaDrawResult,
    PlayerRewardResult,
} from "./types"
import { RewardType } from "./types"
import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantReward,
} from "./reward-grant/types"

type BoxGachaRewardSource = Readonly<
    | { kind: "item", id: number }
    | { kind: "equipment", id: number }
    | { kind: "character", id: number }
    | { kind: "exp" }
    | { kind: "mana" }
>

export interface BoxGachaRewardGrantResult {
    readonly rewardResult: PlayerRewardResult
    readonly playerAfter: RewardGrantPlayerAfter
}

function createBoxGachaRewardPlan(
    drawResult: BoxGachaDrawResult,
): RewardGrantPlan<BoxGachaRewardSource> {
    const entries: Array<{
        source: BoxGachaRewardSource
        reward: RewardGrantReward
    }> = []

    for (const [itemId, count] of drawResult.items) {
        entries.push({
            source: { kind: "item", id: itemId },
            reward: { type: RewardType.ITEM, id: itemId, count },
        })
    }
    for (const [equipmentId, count] of drawResult.equipment) {
        entries.push({
            source: { kind: "equipment", id: equipmentId },
            reward: { type: RewardType.EQUIPMENT, id: equipmentId, count },
        })
    }
    for (const [characterId, count] of drawResult.characters) {
        for (let index = 0; index < count; index++) {
            entries.push({
                source: { kind: "character", id: characterId },
                reward: { type: RewardType.CHARACTER, id: characterId },
            })
        }
    }
    if (drawResult.exp > 0) {
        entries.push({
            source: { kind: "exp" },
            reward: { type: RewardType.EXP, count: drawResult.exp },
        })
    }
    if (drawResult.mana > 0) {
        entries.push({
            source: { kind: "mana" },
            reward: { type: RewardType.MANA, count: drawResult.mana },
        })
    }
    return createRewardGrantPlan(entries)
}

/**
 * Box Gacha remains the source transaction owner. This adapter only translates
 * a completed draw into RewardGrant entries and preserves the legacy Box
 * response projection while sharing the source-owned Inventory context.
 */
export function grantBoxGachaDrawInTransactionOwnerWithInventorySync(
    playerId: number,
    drawResult: BoxGachaDrawResult,
    knownPlayerBefore: RewardGrantPlayerAfter,
    inventory: InventoryBatchContext,
): BoxGachaRewardGrantResult {
    inventory.readMany([...drawResult.items.keys()])
    const result = executeRewardGrantPlanInTransactionOwnerWithInventoryInternalSync(
        playerId,
        createBoxGachaRewardPlan(drawResult),
        knownPlayerBefore,
        inventory,
    )

    // Legacy Box responses expose direct Item rewards as absolute post-state,
    // but duplicate-character compensation as a request-local delta. Preserve
    // that projection without copying the character compensation mapping.
    const items: Record<string, number> = {}
    for (const entry of result.entries) {
        if (entry.source.kind === "item") {
            Object.assign(items, entry.result.items)
            continue
        }
        if (entry.source.kind !== "character" || entry.itemDeltas === undefined) continue
        for (const [itemId, delta] of Object.entries(entry.itemDeltas)) {
            items[itemId] = (items[itemId] ?? 0) + delta
        }
    }

    return {
        rewardResult: {
            ...result.aggregate,
            // The legacy Box facade never populated this list. Character state
            // is still projected through character_list and Awake publication.
            joined_character_id_list: [],
            items,
        },
        playerAfter: result.playerAfter,
    }
}
