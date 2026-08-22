import { getDb } from "../db";
import { PlayerEquipment, RawPlayerEquipment } from "../types";
import { deserializeBoolean, serializeBoolean } from "../utils/primitives";

// SQLite allows 32766 variables; reserve one for player_id in equipment IN queries.
export const MAX_EQUIPMENT_BATCH_IDS = 32765

export function normalizeEquipmentBatchIds(ids: readonly unknown[]): number[] | null {
    const equipmentIds: number[] = []
    const seen = new Set<number>()
    for (const id of ids) {
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null
        if (seen.has(id)) continue
        if (equipmentIds.length >= MAX_EQUIPMENT_BATCH_IDS) return null
        seen.add(id)
        equipmentIds.push(id)
    }
    return equipmentIds
}

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

export function getPlayerEquipmentsByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, PlayerEquipment> {
    const equipmentIds = normalizeEquipmentBatchIds(ids)
    if (equipmentIds === null) {
        throw new TypeError("equipment IDs must be positive safe integers within the batch limit")
    }
    equipmentIds.sort((left, right) => left - right)
    if (equipmentIds.length === 0) return {}
    const placeholders = equipmentIds.map(() => "?").join(", ")
    const rows = getDb().prepare(`
    SELECT id, level, enhancement_level, protection, stack
    FROM players_equipment
    WHERE player_id = ? AND id IN (${placeholders})
    `).all(playerId, ...equipmentIds) as RawPlayerEquipment[]
    return Object.fromEntries(rows.map(raw => [String(raw.id), buildPlayerEquipment(raw)]))
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
