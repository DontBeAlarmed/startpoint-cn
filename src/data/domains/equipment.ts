import { getDb } from "../db";
import { PlayerEquipment, RawPlayerEquipment } from "../types";
import { deserializeBoolean, serializeBoolean } from "../utils/primitives";

/**
 * Converts a RawPlayerEquipment object into a PlayerEquipment object.
 */
function buildPlayerEquipment(rawEquipment: RawPlayerEquipment): PlayerEquipment {
    return {
        level: rawEquipment.level,
        enhancementLevel: rawEquipment.enhancement_level,
        protection: deserializeBoolean(rawEquipment.protection),
        stack: rawEquipment.stack,
    }
}

export function getPlayerEquipmentListSync(playerId: number): Record<string, PlayerEquipment> {
    const db = getDb();
    const rawEquipment = db.prepare(`
    SELECT id, level, enhancement_level, protection, stack
    FROM players_equipment
    WHERE player_id = ?
    `).all(playerId) as RawPlayerEquipment[]

    const final: Record<string, PlayerEquipment> = {}
    for (const raw of rawEquipment) {
        final[raw.id.toString()] = buildPlayerEquipment(raw)
    }
    return final
}

export function getPlayerEquipmentSync(playerId: number, equipmentId: number | string): PlayerEquipment | null {
    const db = getDb();
    const rawEquipment = db.prepare(`
    SELECT id, level, enhancement_level, protection, stack
    FROM players_equipment
    WHERE player_id = ? AND id = ?
    `).get(playerId, Number(equipmentId)) as RawPlayerEquipment | undefined

    return rawEquipment === undefined ? null : buildPlayerEquipment(rawEquipment)
}

export function playerOwnsEquipmentSync(playerId: number, equipmentId: number): boolean {
    const db = getDb();
    return db.prepare(`
    SELECT id FROM players_equipment
    WHERE id = ? AND player_id = ?
    `).get(equipmentId, playerId) !== undefined
}

export function insertPlayerEquipmentSync(playerId: number, equipmentId: string | number, equipment: PlayerEquipment) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_equipment (id, level, enhancement_level, protection, stack, player_id)
    VALUES (?, ?, ?, ?, ?, ?)
    `).run(Number(equipmentId), equipment.level, equipment.enhancementLevel, serializeBoolean(equipment.protection), equipment.stack, playerId)
}

export function insertPlayerEquipmentListSync(playerId: number, equipment: Record<string, PlayerEquipment>) {
    const db = getDb();
    db.transaction(() => {
        for (const [equipmentId, data] of Object.entries(equipment)) {
            insertPlayerEquipmentSync(playerId, equipmentId, data)
        }
    })()
}

export function updatePlayerEquipmentSync(playerId: number, equipmentId: string | number, equipment: Partial<PlayerEquipment>) {
    const db = getDb();
    const fieldMap: Record<string, string> = { 'level': 'level', 'enhancementLevel': 'enhancement_level', 'protection': 'protection', 'stack': 'stack' }
    const sets: string[] = []
    const values: any[] = []
    for (const key in equipment) {
        const value = equipment[key as keyof PlayerEquipment]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            values.push(typeof value === "boolean" ? serializeBoolean(value) : value)
        }
    }
    if (sets.length > 0) db.prepare(`
        UPDATE players_equipment SET ${sets.join(', ')} WHERE id = ? AND player_id = ?
    `).run([...values, Number(equipmentId), playerId])
}

export function deletePlayerEquipmentSync(playerId: number, equipmentId: string | number) {
    const db = getDb();
    db.prepare(`
    DELETE FROM players_equipment WHERE id = ? AND player_id = ?
    `).run(Number(equipmentId), playerId)
}
