import { getDb } from "../db"

export type CharacterAwakeUnlockMap = Map<string, Record<number, number>>
export type CharacterAwakeUnlockRecord = Record<string, Record<number, number>>

interface RawCharacterAwakeUnlock {
    character_id: number
    board_index: number
    awake_level: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function parsePositiveSafeIntegerKey(key: string, path: string): number {
    const value = Number(key)
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== key) {
        throw new TypeError(`${path} must be a positive safe integer.`)
    }
    return value
}

export function getPlayerCharacterAwakeUnlocksSync(
    playerId: number
): CharacterAwakeUnlockMap {
    const rows = getDb().prepare(`
        SELECT character_id, board_index, awake_level
        FROM players_character_awake_unlocks
        WHERE player_id = ?
        ORDER BY character_id, board_index
    `).all(playerId) as RawCharacterAwakeUnlock[]

    const result: CharacterAwakeUnlockMap = new Map()
    for (const row of rows) {
        const characterId = String(row.character_id)
        const awakeLevels = result.get(characterId) ?? {}
        awakeLevels[row.board_index] = row.awake_level
        result.set(characterId, awakeLevels)
    }
    return result
}

export function getPlayerCharacterAwakeUnlocksByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, Record<number, number>> {
    const characterIds = [...new Set(ids)]
    for (const characterId of characterIds) {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw new TypeError("character IDs must be positive safe integers.")
        }
    }
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT character_id, board_index, awake_level
        FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id IN (${placeholders})
        ORDER BY character_id, board_index
    `).all(playerId, ...characterIds) as RawCharacterAwakeUnlock[]
    const result: Record<string, Record<number, number>> = {}
    for (const row of rows) {
        ;(result[String(row.character_id)] ??= {})[row.board_index] = row.awake_level
    }
    return result
}

export function getPlayerCharacterAwakeUnlockRecordSync(
    playerId: number
): CharacterAwakeUnlockRecord {
    return Object.fromEntries(getPlayerCharacterAwakeUnlocksSync(playerId))
}

export function upsertPlayerCharacterAwakeUnlockSync(
    playerId: number,
    characterId: number,
    boardIndex: number,
    awakeLevel: number
): boolean {
    const result = getDb().prepare(`
        INSERT INTO players_character_awake_unlocks
            (player_id, character_id, board_index, awake_level)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id, character_id, board_index) DO UPDATE SET
            awake_level = excluded.awake_level
        WHERE excluded.awake_level > players_character_awake_unlocks.awake_level
    `).run(playerId, characterId, boardIndex, awakeLevel)

    return result.changes > 0
}

export function insertPlayerCharacterAwakeUnlocksSync(
    playerId: number,
    unlocks: CharacterAwakeUnlockRecord
): void {
    if (!isPlainObject(unlocks)) {
        throw new TypeError("characterAwakeUnlocks must be a plain object.")
    }

    const validated: { characterId: number; boardIndex: number; awakeLevel: number }[] = []
    const characterIds = new Set<number>()
    for (const [characterKey, rawBoards] of Object.entries(unlocks)) {
        const characterId = parsePositiveSafeIntegerKey(
            characterKey,
            "characterAwakeUnlocks characterId",
        )
        characterIds.add(characterId)
        if (!isPlainObject(rawBoards)) {
            throw new TypeError(`characterAwakeUnlocks[${characterId}] must be a plain object.`)
        }
        for (const [boardKey, awakeLevel] of Object.entries(rawBoards)) {
            const boardIndex = parsePositiveSafeIntegerKey(
                boardKey,
                `characterAwakeUnlocks[${characterId}] boardIndex`,
            )
            if (!Number.isSafeInteger(awakeLevel) || (awakeLevel as number) <= 0) {
                throw new TypeError(
                    `characterAwakeUnlocks[${characterId}][${boardIndex}] awakeLevel must be a positive safe integer.`,
                )
            }
            validated.push({ characterId, boardIndex, awakeLevel: awakeLevel as number })
        }
    }

    getDb().transaction(() => {
        const characterExists = getDb().prepare(`
            SELECT 1
            FROM players_characters
            WHERE player_id = ? AND id = ?
        `)
        for (const characterId of characterIds) {
            if (characterExists.get(playerId, characterId) === undefined) {
                throw new Error(
                    `characterAwakeUnlocks references unknown character ${characterId}.`,
                )
            }
        }
        for (const entry of validated) {
            upsertPlayerCharacterAwakeUnlockSync(
                playerId,
                entry.characterId,
                entry.boardIndex,
                entry.awakeLevel,
            )
        }
    })()
}
