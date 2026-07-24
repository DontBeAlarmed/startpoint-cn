import { getDb } from "../db"

export interface ActiveMissionCounters {
    totalUsedManaCount: number
    totalGachaCharacterCount: number
    totalEquipmentEquipCount: number
    totalUnisonSetCount: number
    totalPartyCharacterSetCount: number
    totalInjectedExpCount: number
}

export function getActiveMissionCountersSync(playerId: number): ActiveMissionCounters {
    const row = getDb().prepare(`
        SELECT total_used_mana_count, total_gacha_character_count,
            total_equipment_equip_count, total_unison_set_count, total_party_character_set_count,
            total_injected_exp_count
        FROM players_active_mission_counters
        WHERE player_id = ?
    `).get(playerId) as {
        total_used_mana_count: number
        total_gacha_character_count: number
        total_equipment_equip_count: number
        total_unison_set_count: number
        total_party_character_set_count: number
        total_injected_exp_count: number
    } | undefined
    return {
        totalUsedManaCount: Math.max(0, row?.total_used_mana_count ?? 0),
        totalGachaCharacterCount: Math.max(0, row?.total_gacha_character_count ?? 0),
        totalEquipmentEquipCount: Math.max(0, row?.total_equipment_equip_count ?? 0),
        totalUnisonSetCount: Math.max(0, row?.total_unison_set_count ?? 0),
        totalPartyCharacterSetCount: Math.max(0, row?.total_party_character_set_count ?? 0),
        totalInjectedExpCount: Math.max(0, row?.total_injected_exp_count ?? 0),
    }
}

export function incrementActiveMissionUsedManaCountSync(playerId: number, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (player_id, total_used_mana_count)
        VALUES (?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            total_used_mana_count = total_used_mana_count + excluded.total_used_mana_count
    `).run(playerId, amount)
}

export function incrementActiveMissionGachaCharacterCountSync(playerId: number, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (player_id, total_gacha_character_count)
        VALUES (?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            total_gacha_character_count = total_gacha_character_count + excluded.total_gacha_character_count
    `).run(playerId, amount)
}

export interface ActiveMissionPartyActionCounts {
    equipmentEquipCount?: number
    unisonSetCount?: number
    partyCharacterSetCount?: number
}

export function incrementActiveMissionPartyActionCountsSync(
    playerId: number,
    counts: ActiveMissionPartyActionCounts,
): void {
    const equipmentEquipCount = normalizeCounterAmount(counts.equipmentEquipCount)
    const unisonSetCount = normalizeCounterAmount(counts.unisonSetCount)
    const partyCharacterSetCount = normalizeCounterAmount(counts.partyCharacterSetCount)
    if (equipmentEquipCount === 0 && unisonSetCount === 0 && partyCharacterSetCount === 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (
            player_id,
            total_equipment_equip_count,
            total_unison_set_count,
            total_party_character_set_count
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            total_equipment_equip_count = total_equipment_equip_count + excluded.total_equipment_equip_count,
            total_unison_set_count = total_unison_set_count + excluded.total_unison_set_count,
            total_party_character_set_count = total_party_character_set_count + excluded.total_party_character_set_count
    `).run(playerId, equipmentEquipCount, unisonSetCount, partyCharacterSetCount)
}

function normalizeCounterAmount(value: number | undefined): number {
    return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 0
}

export function incrementActiveMissionInjectedExpCountSync(playerId: number): void {
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (player_id, total_injected_exp_count)
        VALUES (?, 1)
        ON CONFLICT(player_id) DO UPDATE SET
            total_injected_exp_count = total_injected_exp_count + 1
    `).run(playerId)
}
