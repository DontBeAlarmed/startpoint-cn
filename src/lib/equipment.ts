import { PlayerEquipment } from "../data/types";
import { getPlayerEquipmentListSync, getPlayerEquipmentSync, insertPlayerEquipmentSync, updatePlayerEquipmentSync } from "../data/domains/equipment"

/**
 * Serializes a PlayerEquipment object for sending to the game client.
 *
 * @param equipmentId The ID of the equipment to serialize.
 * @param toSerialize The data of the equipment to serialize.
 * @returns A serialized equipment object for returning to the game client.
 */
export function clientSerializeEquipment(
    equipmentId: number,
    toSerialize: PlayerEquipment
): Object {
    return {
        "equipment_id": equipmentId,
        "protection": toSerialize.protection,
        "level": toSerialize.level,
        "enhancement_level": toSerialize.enhancementLevel,
        "stack": toSerialize.stack
    }
}

/**
 * Builds a full equipment list array for client response.
 * Used by all equipment endpoints (sell, upgrade, dismantle) to return a
 * complete snapshot of the player's equipment after any modifications.
 */
export function buildFullEquipmentList(playerId: number): Object[] {
    return serializeFullEquipmentList(getPlayerEquipmentListSync(playerId))
}

export function serializeFullEquipmentList(
    allEquipment: Readonly<Record<string, PlayerEquipment>>,
): Object[] {
    const list: Object[] = []
    for (const [equipId, equip] of Object.entries(allEquipment)) {
        list.push(clientSerializeEquipment(parseInt(equipId), equip))
    }
    return list
}

/**
 * Gives a player an amount of equipment.
 * 
 * @param playerId The ID of the player to give the equipment to.
 * @param equipmentId The ID of the equipment to give.
 * @param amount The amount of equipment to give.
 * @returns A serialized equipment object for returning to the game client.
 */
export function givePlayerEquipmentSync(
    playerId: number,
    equipmentId: number,
    amount: number
): Object {
    amount = Math.abs(amount) // ensure that amount isn't negative.

    let owned: PlayerEquipment | null = getPlayerEquipmentSync(playerId, equipmentId)

    if (owned === null) {
        // insert into inventory since it's not owned.
        owned = {
            enhancementLevel: 0,
            level: 1,
            protection: false,
            stack: amount - 1
        }
        insertPlayerEquipmentSync(playerId, equipmentId, owned)
    } else {
        // simply increase the stack
        const newStack = owned.stack + amount
        updatePlayerEquipmentSync(playerId, equipmentId, {
            stack: newStack
        })
        owned.stack = newStack
    }

    return clientSerializeEquipment(equipmentId, owned)
}
