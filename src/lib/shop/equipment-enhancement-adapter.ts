import {
    getPlayerEquipmentSync,
    updatePlayerEquipmentSync,
} from "../../data/domains/equipment"
import type { PlayerEquipment } from "../../data/types"
import { planEquipmentEnhancementPurchase } from "../equipment-enhancement"
import type { ShopCatalog } from "./model"
import type {
    PreparedShopPurchaseEntry,
    ShopPurchaseEffect,
} from "./purchase-plan"
import { ShopPurchasePlanError } from "./purchase-validation"

export interface PreparedEquipmentEnhancement {
    readonly shopItemId: number
    readonly equipmentId: number
    readonly before: Readonly<PlayerEquipment>
    readonly after: Readonly<PlayerEquipment>
}

export function prepareEquipmentEnhancementWithinTransactionSync(
    playerId: number,
    entry: PreparedShopPurchaseEntry,
    effect: Extract<ShopPurchaseEffect, { kind: "equipmentEnhancement" }>,
    catalog: ShopCatalog,
): PreparedEquipmentEnhancement {
    if (entry.offer.scope.kind !== "equipmentEnhancement"
        || entry.shopItemId !== effect.shopItemId
        || entry.offer.scope.equipmentId !== effect.equipmentId) {
        throw new ShopPurchasePlanError("Equipment enhancement scope is invalid.")
    }
    const equipment = getPlayerEquipmentSync(playerId, effect.equipmentId)
    if (equipment === null) {
        throw new ShopPurchasePlanError("Player does not own the target equipment.")
    }
    const groupKey = `${entry.offer.scope.categoryId}:${entry.offer.scope.groupId}:${effect.equipmentId}`
    const stageIds = catalog.equipmentGroupProductIds[groupKey] ?? []
    const currentStageId = stageIds.find(shopItemId => {
        const stage = catalog.entries[`${entry.offer.shopType}:${shopItemId}`]
        return stage?.kind === "purchase"
            && (stage.item.enhancementMaxLevel ?? 0) > equipment.enhancementLevel
    })
    if (currentStageId !== effect.shopItemId) {
        throw new ShopPurchasePlanError("Enhancement item is not the current stage.")
    }
    const plan = planEquipmentEnhancementPurchase(
        equipment.enhancementLevel,
        effect.purchaseAmount,
        effect.enhancementMaxLevel,
        equipment.level,
        effect.requireAwakeningLevel,
    )
    if (!plan.ok) throw new ShopPurchasePlanError(plan.message)
    return {
        shopItemId: effect.shopItemId,
        equipmentId: effect.equipmentId,
        before: { ...equipment },
        after: { ...equipment, enhancementLevel: plan.newLevel },
    }
}

export function applyPreparedEquipmentEnhancementWithinTransactionSync(
    playerId: number,
    prepared: PreparedEquipmentEnhancement,
): void {
    updatePlayerEquipmentSync(playerId, prepared.equipmentId, {
        enhancementLevel: prepared.after.enhancementLevel,
    })
}
