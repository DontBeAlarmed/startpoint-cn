interface EquipmentAwakeningCrystalRule {
    targetRarity: number
    allowsBelowRarity: boolean
}

// CN ItemTable effect=EquipmentAwakingCrystal (6).
const equipmentAwakeningCrystalRules: Record<number, EquipmentAwakeningCrystalRule> = {
    12001: { targetRarity: 4, allowsBelowRarity: true },
    12002: { targetRarity: 5, allowsBelowRarity: false },
}

export function canUseEquipmentAwakeningCrystal(itemId: number, equipmentRarity: number): boolean {
    const rule = equipmentAwakeningCrystalRules[itemId]
    if (!rule) return false
    return equipmentRarity === rule.targetRarity
        || (rule.allowsBelowRarity && equipmentRarity < rule.targetRarity)
}
