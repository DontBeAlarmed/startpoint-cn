export type EquipmentEnhancementPurchasePlan =
    | { ok: true; newLevel: number }
    | { ok: false; message: string }

export function planEquipmentEnhancementPurchase(
    currentLevel: number,
    purchaseAmount: number,
    stageMaxLevel: number,
    currentAwakeningLevel: number,
    requiredAwakeningLevel: number,
): EquipmentEnhancementPurchasePlan {
    if (!Number.isInteger(purchaseAmount) || purchaseAmount <= 0) {
        return { ok: false, message: "Invalid enhancement purchase amount." }
    }
    if (currentAwakeningLevel < requiredAwakeningLevel) {
        return { ok: false, message: "Equipment awakening level is too low." }
    }

    const newLevel = currentLevel + purchaseAmount
    if (currentLevel < 0 || stageMaxLevel <= currentLevel || newLevel > stageMaxLevel) {
        return { ok: false, message: "Enhancement purchase exceeds the current stage." }
    }

    return { ok: true, newLevel }
}
