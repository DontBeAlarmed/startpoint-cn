import { PlayerEquipment } from "../data/types"

export interface PartyLoadoutInput {
    equipment_ids: (number | null)[]
    ability_soul_ids: (number | null)[]
}

export interface PartyLoadoutInventory {
    equipments: Readonly<Record<string, PlayerEquipment | { stack: number }>>
    items: Readonly<Record<string, number>>
}

export type PartyLoadoutValidationResult =
    | { ok: true }
    | {
        ok: false
        reason: "invalid_id" | "duplicate_equipment" | "equipment_not_owned" | "ability_soul_shortage"
        id: number
    }

function isInventoryId(value: number | null): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

export function validatePartyLoadouts(
    parties: readonly PartyLoadoutInput[],
    inventory: PartyLoadoutInventory,
): PartyLoadoutValidationResult {
    for (const party of parties) {
        const usedEquipment = new Set<number>()
        for (const equipmentId of party.equipment_ids) {
            if (equipmentId === null) continue
            if (!isInventoryId(equipmentId)) return { ok: false, reason: "invalid_id", id: Number(equipmentId) }
            if (usedEquipment.has(equipmentId)) {
                return { ok: false, reason: "duplicate_equipment", id: equipmentId }
            }
            if (inventory.equipments[String(equipmentId)] === undefined) {
                return { ok: false, reason: "equipment_not_owned", id: equipmentId }
            }
            usedEquipment.add(equipmentId)
        }

        const usedSouls = new Map<number, number>()
        for (const abilitySoulId of party.ability_soul_ids) {
            if (abilitySoulId === null) continue
            if (!isInventoryId(abilitySoulId)) return { ok: false, reason: "invalid_id", id: Number(abilitySoulId) }
            const useCount = (usedSouls.get(abilitySoulId) ?? 0) + 1
            if (useCount > (inventory.items[String(abilitySoulId)] ?? 0)) {
                return { ok: false, reason: "ability_soul_shortage", id: abilitySoulId }
            }
            usedSouls.set(abilitySoulId, useCount)
        }
    }
    return { ok: true }
}
