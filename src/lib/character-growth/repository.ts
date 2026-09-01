import { getDb } from "../../data/db"
import { getPlayerCharacterAwakeUnlocksByIdsSync } from "../../data/domains/character_awake"
import {
    getPlayerCharacterBondTokensByIdsSync,
    getPlayerCharactersManaNodeAwakeLevelsByIdsSync,
} from "../../data/domains/character"
import { getPlayerItemsByIdsSync } from "../../data/domains/item"
import { growthError } from "./errors"
import {
    validateAwakeLevel,
    validateAwakeUnlockRows,
    validateBondTokenRows,
    validateBondTokenStatus,
    validateBoardIndex,
} from "./invariants"
import type {
    BondTokenStatus,
    CharacterGrowthAwakeUnlockRow,
    CharacterGrowthBondTokenRow,
    CharacterGrowthStoredCore,
} from "./model"

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a positive safe integer.`)
    }
    return value
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a non-negative safe integer.`)
    }
    return value
}

export function validateCharacterGrowthStoredCore(
    core: CharacterGrowthStoredCore,
): CharacterGrowthStoredCore {
    if (typeof core.protection !== "boolean") {
        throw growthError("INVALID_GROWTH_STATE", "character.protection must be boolean.")
    }
    return {
        characterId: positiveInteger(core.characterId, "character.id"),
        exp: nonNegativeInteger(core.exp, "character.exp"),
        stack: nonNegativeInteger(core.stack, "character.stack"),
        protection: core.protection,
        overLimitStep: nonNegativeInteger(core.overLimitStep, "character.over_limit_step"),
        evolutionLevel: nonNegativeInteger(core.evolutionLevel, "character.evolution_level"),
        manaBoardIndex: validateBoardIndex(core.manaBoardIndex),
    }
}

function normalizeIds(ids: readonly number[]): number[] {
    const normalized = [...new Set(ids)]
    for (const id of normalized) positiveInteger(id, "characterId")
    return normalized.sort((left, right) => left - right)
}

interface RawCoreRow {
    id: number
    exp: number
    stack: number
    protection: number
    over_limit_step: number
    evolution_level: number
    mana_board_index: number
}

function buildCore(row: RawCoreRow): CharacterGrowthStoredCore {
    if (row.protection !== 0 && row.protection !== 1) {
        throw growthError("INVALID_GROWTH_STATE", "character.protection must be 0 or 1.")
    }
    return validateCharacterGrowthStoredCore({
        characterId: row.id,
        exp: row.exp,
        stack: row.stack,
        protection: row.protection === 1,
        overLimitStep: row.over_limit_step,
        evolutionLevel: row.evolution_level,
        manaBoardIndex: row.mana_board_index,
    })
}

export class CharacterGrowthRepository {
    getCharacterSync(playerId: number, characterId: number): CharacterGrowthStoredCore | null {
        const row = getDb().prepare(`
            SELECT id, exp, stack, protection, over_limit_step, evolution_level, mana_board_index
            FROM players_characters
            WHERE player_id = ? AND id = ?
        `).get(playerId, characterId) as RawCoreRow | undefined
        return row === undefined ? null : buildCore(row)
    }

    getCharactersByIdsSync(
        playerId: number,
        ids: readonly number[],
    ): Record<string, CharacterGrowthStoredCore> {
        const characterIds = normalizeIds(ids)
        if (characterIds.length === 0) return {}
        const placeholders = characterIds.map(() => "?").join(", ")
        const rows = getDb().prepare(`
            SELECT id, exp, stack, protection, over_limit_step, evolution_level, mana_board_index
            FROM players_characters
            WHERE player_id = ? AND id IN (${placeholders})
            ORDER BY id
        `).all(playerId, ...characterIds) as RawCoreRow[]
        return Object.fromEntries(rows.map(row => {
            const core = buildCore(row)
            return [String(core.characterId), core]
        }))
    }

    getBondTokensSync(playerId: number, characterId: number): ReadonlyMap<number, BondTokenStatus> {
        return this.getBondTokensByCharacterIdsSync(playerId, [characterId])[String(characterId)] ?? new Map()
    }

    getBondTokensByCharacterIdsSync(
        playerId: number,
        ids: readonly number[],
    ): Record<string, ReadonlyMap<number, BondTokenStatus>> {
        const characterIds = normalizeIds(ids)
        if (characterIds.length === 0) return {}
        const buckets = getPlayerCharacterBondTokensByIdsSync(playerId, characterIds)
        return Object.fromEntries(characterIds.map(characterId => [
            String(characterId),
            this.toBondTokenMap((buckets[String(characterId)] ?? []).map(token => ({
                character_id: characterId,
                mana_board_index: token.manaBoardIndex,
                status: token.status,
            }))),
        ]))
    }

    getNormalManaNodesSync(playerId: number, characterId: number): ReadonlyMap<number, number> {
        return this.getNormalManaNodesByCharacterIdsSync(playerId, [characterId])[String(characterId)] ?? new Map()
    }

    getNormalManaNodesByCharacterIdsSync(
        playerId: number,
        ids: readonly number[],
    ): Record<string, ReadonlyMap<number, number>> {
        const characterIds = normalizeIds(ids)
        if (characterIds.length === 0) return {}
        const buckets = getPlayerCharactersManaNodeAwakeLevelsByIdsSync(playerId, characterIds)
        return Object.fromEntries(characterIds.map(characterId => [
            String(characterId),
            this.toNormalManaNodeMap(buckets[String(characterId)] ?? {}),
        ]))
    }

    getAwakeUnlocksSync(playerId: number, characterId: number): ReadonlyMap<number, number> {
        return this.getAwakeUnlocksByCharacterIdsSync(playerId, [characterId])[String(characterId)] ?? new Map()
    }

    getAwakeUnlocksByCharacterIdsSync(
        playerId: number,
        ids: readonly number[],
    ): Record<string, ReadonlyMap<number, number>> {
        const characterIds = normalizeIds(ids)
        if (characterIds.length === 0) return {}
        const buckets = getPlayerCharacterAwakeUnlocksByIdsSync(playerId, characterIds)
        return Object.fromEntries(characterIds.map(characterId => {
            const raw = buckets[String(characterId)] ?? {}
            const rows = Object.entries(raw).map(([boardIndex, awakeLevel]) => ({
                character_id: characterId,
                board_index: Number(boardIndex),
                awake_level: awakeLevel,
            }))
            return [String(characterId), this.toAwakeUnlockMap(rows)]
        }))
    }

    getRequiredItemsSync(playerId: number, ids: readonly number[]): ReadonlyMap<number, number> {
        const itemIds = [...new Set(ids)]
        for (const itemId of itemIds) positiveInteger(itemId, "itemId")
        const values = getPlayerItemsByIdsSync(playerId, itemIds)
        const result = new Map<number, number>()
        for (const [itemId, amount] of Object.entries(values)) {
            result.set(positiveInteger(Number(itemId), "item.id"), nonNegativeInteger(amount, "item.amount"))
        }
        return result
    }

    private toBondTokenMap(rows: readonly CharacterGrowthBondTokenRow[]): ReadonlyMap<number, BondTokenStatus> {
        const validated = validateBondTokenRows(rows)
        const result = new Map<number, BondTokenStatus>()
        for (const row of validated) {
            result.set(validateBoardIndex(row.mana_board_index), validateBondTokenStatus(row.status))
        }
        return result
    }

    private toNormalManaNodeMap(values: Readonly<Record<string, number>>): ReadonlyMap<number, number> {
        const result = new Map<number, number>()
        for (const [rawNodeId, awakeLevel] of Object.entries(values)) {
            result.set(
                positiveInteger(Number(rawNodeId), "manaNode.value"),
                nonNegativeInteger(awakeLevel, "manaNode.awake_level"),
            )
        }
        return result
    }

    private toAwakeUnlockMap(rows: readonly CharacterGrowthAwakeUnlockRow[]): ReadonlyMap<number, number> {
        const validated = validateAwakeUnlockRows(rows)
        return new Map(validated.map(row => [
            validateBoardIndex(row.board_index),
            validateAwakeLevel(row.awake_level),
        ]))
    }
}
