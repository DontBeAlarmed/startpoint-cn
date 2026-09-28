import { getDb } from "../db"
import type {
    PlayerCrazyGachaResult,
    PlayerGachaConversion,
} from "../types"

interface RawCrazyResult {
    gacha_id: number
    slot_index: 0 | 1 | 2
    position: number
    character_id: number
    movie_id: string | null
    seed: number | null
    entry_count: number | null
    ex_boost_item_id: number | null
    ex_boost_item_count: number | null
}

interface RawConversion {
    gacha_id: number
    pending_point: number
    converted_at: number
    shown: number
}

function positiveInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value as number
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value as number
}

function crazyFromRaw(row: RawCrazyResult): PlayerCrazyGachaResult {
    return {
        gachaId: row.gacha_id,
        slotIndex: row.slot_index,
        position: row.position,
        characterId: row.character_id,
        movieId: row.movie_id,
        seed: row.seed,
        entryCount: row.entry_count,
        exBoostItemId: row.ex_boost_item_id,
        exBoostItemCount: row.ex_boost_item_count,
    }
}

function conversionFromRaw(row: RawConversion): PlayerGachaConversion {
    return {
        gachaId: row.gacha_id,
        pendingPoint: row.pending_point,
        convertedAt: row.converted_at,
        shown: row.shown === 1,
    }
}

export function getPlayerCrazyGachaResultsSync(
    playerId: number,
    gachaId: number,
): PlayerCrazyGachaResult[] {
    return (getDb().prepare(`
        SELECT gacha_id, slot_index, position, character_id, movie_id, seed,
            entry_count, ex_boost_item_id, ex_boost_item_count
        FROM players_gacha_crazy_results
        WHERE player_id = ? AND gacha_id = ?
        ORDER BY slot_index, position
    `).all(playerId, gachaId) as RawCrazyResult[]).map(crazyFromRaw)
}

export function getPlayerCrazyGachaGachaIdsSync(playerId: number): number[] {
    return (getDb().prepare(`
        SELECT DISTINCT gacha_id
        FROM players_gacha_crazy_results
        WHERE player_id = ?
        ORDER BY gacha_id
    `).all(playerId) as Array<{ gacha_id: number }>).map(row => row.gacha_id)
}

export function getPlayerCrazyGachaIdsWithSlotZeroSync(playerId: number): number[] {
    return (getDb().prepare(`
        SELECT gacha_id
        FROM players_gacha_crazy_results
        WHERE player_id = ? AND slot_index = 0
        GROUP BY gacha_id
        HAVING COUNT(*) = 10
        ORDER BY gacha_id
    `).all(playerId) as Array<{ gacha_id: number }>).map(row => row.gacha_id)
}

export function replacePlayerCrazyGachaSlotZeroSync(input: {
    readonly playerId: number
    readonly gachaId: number
    readonly draws: readonly Readonly<{
        characterId: number
        movieId: string
        seed: number
        entryCount: number
        exBoostItemId: number | null
        exBoostItemCount: number | null
    }>[]
}): void {
    positiveInteger(input.playerId, "playerId")
    positiveInteger(input.gachaId, "gachaId")
    if (input.draws.length !== 10) throw new TypeError("Crazy Gacha slot must contain 10 draws")
    const db = getDb()
    db.prepare(`DELETE FROM players_gacha_crazy_results
        WHERE player_id = ? AND gacha_id = ? AND slot_index = 0`).run(
        input.playerId,
        input.gachaId,
    )
    const insert = db.prepare(`
        INSERT INTO players_gacha_crazy_results (
            player_id, gacha_id, slot_index, position, character_id, movie_id,
            seed, entry_count, ex_boost_item_id, ex_boost_item_count
        ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `)
    input.draws.forEach((draw, position) => {
        positiveInteger(draw.characterId, "characterId")
        nonNegativeInteger(draw.seed, "seed")
        positiveInteger(draw.entryCount, "entryCount")
        if (draw.movieId.length === 0) throw new TypeError("Crazy Gacha movieId is empty")
        if ((draw.exBoostItemId === null) !== (draw.exBoostItemCount === null)) {
            throw new TypeError("Crazy Gacha EX Boost fields are partial")
        }
        if (draw.exBoostItemId !== null) {
            positiveInteger(draw.exBoostItemId, "exBoostItemId")
            nonNegativeInteger(draw.exBoostItemCount, "exBoostItemCount")
        }
        insert.run(
            input.playerId,
            input.gachaId,
            position,
            draw.characterId,
            draw.movieId,
            draw.seed,
            draw.entryCount,
            draw.exBoostItemId,
            draw.exBoostItemCount,
        )
    })
}

export function savePlayerCrazyGachaSlotSync(
    playerId: number,
    gachaId: number,
    targetSlot: 1 | 2,
): boolean {
    const db = getDb()
    const source = db.prepare(`
        SELECT position, character_id
        FROM players_gacha_crazy_results
        WHERE player_id = ? AND gacha_id = ? AND slot_index = 0
        ORDER BY position
    `).all(playerId, gachaId) as Array<{ position: number, character_id: number }>
    if (source.length !== 10 || source.some((row, index) => row.position !== index)) return false
    const targetCount = db.prepare(`SELECT COUNT(*) AS count
        FROM players_gacha_crazy_results
        WHERE player_id = ? AND gacha_id = ? AND slot_index = ?`).get(
        playerId,
        gachaId,
        targetSlot,
    ) as { count: number }
    if (targetCount.count !== 0) return false
    const insert = db.prepare(`
        INSERT INTO players_gacha_crazy_results (
            player_id, gacha_id, slot_index, position, character_id
        ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const row of source) insert.run(
        playerId,
        gachaId,
        targetSlot,
        row.position,
        row.character_id,
    )
    return true
}

export function clearPlayerCrazyGachaResultsSync(playerId: number, gachaId: number): void {
    getDb().prepare(`DELETE FROM players_gacha_crazy_results
        WHERE player_id = ? AND gacha_id = ?`).run(playerId, gachaId)
}

export function getPendingPlayerGachaConversionsSync(
    playerId: number,
): PlayerGachaConversion[] {
    return (getDb().prepare(`
        SELECT gacha_id, pending_point, converted_at, shown
        FROM players_gacha_conversions
        WHERE player_id = ? AND shown = 0
        ORDER BY converted_at, gacha_id
    `).all(playerId) as RawConversion[]).map(conversionFromRaw)
}

export function recordPlayerGachaConversionSync(input: {
    readonly playerId: number
    readonly gachaId: number
    readonly point: number
    readonly convertedAt: number
}): void {
    positiveInteger(input.point, "point")
    nonNegativeInteger(input.convertedAt, "convertedAt")
    getDb().prepare(`
        INSERT INTO players_gacha_conversions (
            player_id, gacha_id, pending_point, converted_at, shown
        ) VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(player_id, gacha_id) DO UPDATE SET
            pending_point = CASE
                WHEN players_gacha_conversions.shown = 0
                THEN players_gacha_conversions.pending_point + excluded.pending_point
                ELSE excluded.pending_point
            END,
            converted_at = excluded.converted_at,
            shown = 0
    `).run(input.playerId, input.gachaId, input.point, input.convertedAt)
}

export function markPlayerGachaConversionShownSync(
    playerId: number,
    gachaId: number,
): void {
    getDb().prepare(`UPDATE players_gacha_conversions SET shown = 1
        WHERE player_id = ? AND gacha_id = ? AND shown = 0`).run(playerId, gachaId)
}
