import { getDb } from "../db"
import type { PlayerCharacter, PlayerEquipment } from "../types"
import { deserializeNumberList, serializeBoolean, serializeNumberList } from "../utils/primitives"

export interface CharacterAcquisitionFinalState {
    readonly characterId: number
    readonly character: PlayerCharacter
    readonly wasOwned: boolean
}

export interface EquipmentAcquisitionFinalState {
    readonly equipmentId: number
    readonly equipment: PlayerEquipment
}

interface RawCharacterAcquisitionRow {
    id: number
    entry_count: number
    evolution_level: number
    over_limit_step: number
    protection: number
    join_time: string
    update_time: string
    exp: number
    stack: number
    mana_board_index: number
    ex_boost_status_id: number | null
    ex_boost_ability_id_list: string | null
    illustration_settings: string | null
}

interface RawCharacterAcquisitionBondRow {
    character_id: number
    mana_board_index: number
    status: number
}

function placeholders(rowCount: number, columns: number): string {
    return Array.from({ length: rowCount }, () => (
        `(${Array(columns).fill("?").join(", ")})`
    )).join(", ")
}

export function getCharacterAcquisitionStatesSync(
    playerId: number,
    rawIds: readonly number[],
): Record<string, PlayerCharacter> {
    const ids = [...new Set(rawIds)].sort((left, right) => left - right)
    if (ids.length === 0) return {}
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        throw new TypeError("Character acquisition IDs must be positive safe integers")
    }
    const rows = getDb().prepare(`
        SELECT character.id, character.entry_count, character.evolution_level,
            character.over_limit_step, character.protection, character.join_time,
            character.update_time, character.exp, character.stack,
            character.mana_board_index, character.ex_boost_status_id,
            character.ex_boost_ability_id_list, character.illustration_settings
        FROM players_characters AS character
        WHERE character.player_id = ? AND character.id IN (${ids.map(() => "?").join(", ")})
        ORDER BY character.id
    `).all(playerId, ...ids) as RawCharacterAcquisitionRow[]
    const output: Record<string, PlayerCharacter> = {}
    for (const row of rows) {
        if (row.protection !== 0 && row.protection !== 1) {
            throw new TypeError("Character acquisition protection is invalid")
        }
        const key = String(row.id)
        const joinTime = new Date(row.join_time)
        const updateTime = new Date(row.update_time)
        if (!Number.isFinite(joinTime.getTime()) || !Number.isFinite(updateTime.getTime())) {
            throw new TypeError("Character acquisition timestamps are invalid")
        }
        const character: PlayerCharacter = {
            entryCount: row.entry_count,
            evolutionLevel: row.evolution_level,
            overLimitStep: row.over_limit_step,
            protection: row.protection === 1,
            joinTime,
            updateTime,
            exp: row.exp,
            stack: row.stack,
            manaBoardIndex: row.mana_board_index,
            bondTokenList: [],
            ...(row.ex_boost_status_id === null || row.ex_boost_ability_id_list === null
                ? {}
                : { exBoost: {
                    statusId: row.ex_boost_status_id,
                    abilityIdList: deserializeNumberList(row.ex_boost_ability_id_list),
                } }),
            ...(row.illustration_settings === null
                ? {}
                : { illustrationSettings: deserializeNumberList(row.illustration_settings) }),
        }
        output[key] = character
    }
    const existingIds = rows.map(row => row.id)
    if (existingIds.length > 0) {
        const bondRows = getDb().prepare(`
            SELECT character_id, mana_board_index, status
            FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id IN (${existingIds.map(() => "?").join(", ")})
            ORDER BY character_id, mana_board_index
        `).all(playerId, ...existingIds) as RawCharacterAcquisitionBondRow[]
        for (const row of bondRows) {
            output[String(row.character_id)].bondTokenList.push({
                manaBoardIndex: row.mana_board_index,
                status: row.status,
            })
        }
    }
    return output
}

export function persistCharacterAcquisitionBatchSync(
    playerId: number,
    states: readonly CharacterAcquisitionFinalState[],
): void {
    if (states.length === 0) return
    const values: unknown[] = []
    for (const state of states) {
        const character = state.character
        values.push(
            state.characterId,
            character.entryCount,
            character.evolutionLevel,
            character.overLimitStep,
            serializeBoolean(character.protection),
            character.joinTime.toISOString(),
            character.updateTime.toISOString(),
            character.exp,
            character.stack,
            character.manaBoardIndex,
            playerId,
            character.exBoost?.statusId ?? null,
            character.exBoost?.abilityIdList === undefined
                ? null : serializeNumberList(character.exBoost.abilityIdList),
            character.illustrationSettings === undefined
                ? null : serializeNumberList(character.illustrationSettings),
        )
    }
    const result = getDb().prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id,
            ex_boost_status_id, ex_boost_ability_id_list, illustration_settings
        ) VALUES ${placeholders(states.length, 14)}
        ON CONFLICT(id, player_id) DO UPDATE SET
            stack = excluded.stack,
            update_time = excluded.update_time
    `).run(...values)
    if (result.changes !== states.length) {
        throw new Error("Character acquisition batch did not write every final state")
    }

    const newStates = states.filter(state => !state.wasOwned)
    const bondRows = newStates.flatMap(state => state.character.bondTokenList.map(token => [
        token.manaBoardIndex,
        token.status,
        playerId,
        state.characterId,
    ]))
    if (bondRows.length > 0) {
        getDb().prepare(`
            INSERT INTO players_characters_bond_tokens (
                mana_board_index, status, player_id, character_id
            ) VALUES ${placeholders(bondRows.length, 4)}
        `).run(...bondRows.flat())
    }
}

export function persistEquipmentAcquisitionBatchSync(
    playerId: number,
    states: readonly EquipmentAcquisitionFinalState[],
): void {
    if (states.length === 0) return
    const values: unknown[] = []
    for (const state of states) {
        values.push(
            state.equipmentId,
            state.equipment.level,
            state.equipment.enhancementLevel,
            serializeBoolean(state.equipment.protection),
            state.equipment.stack,
            playerId,
        )
    }
    const result = getDb().prepare(`
        INSERT INTO players_equipment (
            id, level, enhancement_level, protection, stack, player_id
        ) VALUES ${placeholders(states.length, 6)}
        ON CONFLICT(id, player_id) DO UPDATE SET
            stack = excluded.stack
    `).run(...values)
    if (result.changes !== states.length) {
        throw new Error("Equipment acquisition batch did not write every final state")
    }
}
