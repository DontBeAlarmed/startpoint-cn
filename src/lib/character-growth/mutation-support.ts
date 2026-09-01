import { getDb } from "../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getRealNow } from "../../runtime/time/game-time"
import { growthError } from "./errors"
import type { CharacterGrowthCoreFact } from "./model"

export function validateGrowthCommandIds(
    playerId: unknown,
    characterId: unknown,
): asserts playerId is number {
    if (typeof playerId !== "number" || !Number.isSafeInteger(playerId) || playerId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
    if (typeof characterId !== "number" || !Number.isSafeInteger(characterId) || characterId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "characterId must be a positive safe integer.")
    }
}

export function validateGrowthPlayerId(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
}

export function validatePositiveAmount(value: unknown, field: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_REQUEST", `${field} must be a positive safe integer.`)
    }
}

export function validateNonNegativeAmount(value: unknown, field: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw growthError("INVALID_REQUEST", `${field} must be a non-negative safe integer.`)
    }
}

export function validateEvaluationTime(value: unknown): asserts value is Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw growthError("INVALID_GROWTH_STATE", "evaluationTime must be a valid Date.")
    }
}

export function getRequiredPlayerSync(playerId: number) {
    const player = getPlayerSync(playerId)
    if (player === null) throw growthError("INVALID_GROWTH_STATE", `player ${playerId} is unavailable.`)
    return player
}

export function addSafeInteger(left: number, right: number, field: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} exceeds the safe integer range.`)
    }
    return result
}

export interface GrowthRowUpdate {
    readonly characterId: number
    readonly exp?: number
    readonly stack?: number
    readonly overLimitStep?: number
}

/**
 * Writes a set of character core fields with one UPDATE statement. The
 * command callers have already validated the complete after-state, so this
 * deliberately avoids per-character domain writes on batch paths.
 */
export function updateCharacterGrowthRowsSync(
    playerId: number,
    updates: readonly GrowthRowUpdate[],
): Date | null {
    if (updates.length === 0) return null
    const unique = new Map<number, GrowthRowUpdate>()
    for (const update of updates) unique.set(update.characterId, update)
    const rows = [...unique.values()].sort((left, right) => left.characterId - right.characterId)
    const fields: readonly [keyof GrowthRowUpdate, string][] = [
        ["exp", "exp"],
        ["stack", "stack"],
        ["overLimitStep", "over_limit_step"],
    ]
    const sets: string[] = []
    const values: unknown[] = []
    for (const [property, column] of fields) {
        const changed = rows.filter(row => row[property] !== undefined)
        if (changed.length === 0) continue
        sets.push(`${column} = CASE id ${changed.map(() => "WHEN ? THEN ?").join(" ")} ELSE ${column} END`)
        for (const row of changed) values.push(row.characterId, row[property])
    }
    if (sets.length === 0) return null
    const updateTime = getRealNow()
    sets.push("update_time = ?")
    values.push(updateTime.toISOString())
    const placeholders = rows.map(() => "?").join(", ")
    values.push(playerId, ...rows.map(row => row.characterId))
    getDb().prepare(`
        UPDATE players_characters
        SET ${sets.join(", ")}
        WHERE player_id = ? AND id IN (${placeholders})
    `).run(...values)
    return updateTime
}

export function updatePlayerExpPoolSync(playerId: number, expPool: number): void {
    updatePlayerSync({ id: playerId, expPool })
}

export function assertInsideTransaction(): void {
    if (!getDb().inTransaction) {
        throw new Error("character growth mutation requires an active transaction")
    }
}

export function observedCore(
    character: CharacterGrowthCoreFact,
    patch: Partial<Pick<CharacterGrowthCoreFact, "exp" | "stack" | "overLimitStep">>,
): CharacterGrowthCoreFact {
    return { ...character, ...patch }
}

export function runGrowthTransaction<T>(operation: () => T): T {
    return getDb().transaction(operation)()
}
