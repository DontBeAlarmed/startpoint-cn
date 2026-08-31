import { getDb } from "../db";
import { PlayerCharacter, PlayerCharacterBondToken, PlayerCharacterExBoost, RawPlayerCharacter, RawPlayerCharacterBondToken, RawPlayerCharacterManaNode } from "../types";
import { deserializeBoolean, deserializeNumberList, serializeBoolean, serializeNumberList } from "../utils/primitives";
import { getCharacterDataSync } from "../../lib/assets";
import { getRealNow } from "../../runtime/time/game-time";

export interface PlayerCharacterGrowthFact {
    readonly exp: number
}

function normalizeCharacterFactIds(ids: readonly number[]): number[] {
    const normalized = new Set<number>()
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new TypeError("character fact IDs must be positive safe integers.")
        }
        normalized.add(id)
    }
    return [...normalized].sort((left, right) => left - right)
}

/**
 * Converts a RawPlayerCharacterBondToken into a PlayerCharacterBondToken
 * 
 * @param rawBondToken The raw bond token to build/deserialize
 * @returns The built/deserialized PlayerCharacterBondToken
 */
function buildCharacterBondToken(
    rawBondToken: RawPlayerCharacterBondToken
): PlayerCharacterBondToken {
    return {
        manaBoardIndex: rawBondToken.mana_board_index,
        status: rawBondToken.status
    }
}

/**
 * Builds a PlayerCharacterExBoost object.
 * 
 * @param exBoostStatusId The ex boost's status ID
 * @param exBoostAbilityIdList The serialized string representing the ex boost's ability id list.
 * @returns A PlayerCharacterExBoost object or undefined.
 */
function buildPlayerCharacterExBoost(
    exBoostStatusId: number | null,
    exBoostAbilityIdList: string | null
): PlayerCharacterExBoost | undefined {
    if (exBoostStatusId === null || exBoostAbilityIdList === null) return undefined
    return {
        statusId: exBoostStatusId,
        abilityIdList: deserializeNumberList(exBoostAbilityIdList)
    }
}

/**
 * Converts a RawPlayerCharacter into a PlayerCharacter
 * 
 * @param rawCharacter The RawPlayerCharacter to convert.
 * @param bondTokens The character's bond tokens
 * @returns The converted PlayerCharacter
 */
function buildPlayerCharacter(
    rawCharacter: RawPlayerCharacter,
    bondTokens: PlayerCharacterBondToken[]
): PlayerCharacter {
    return {
        entryCount: rawCharacter.entry_count,
        evolutionLevel: rawCharacter.evolution_level,
        overLimitStep: rawCharacter.over_limit_step,
        protection: deserializeBoolean(rawCharacter.protection),
        joinTime: new Date(rawCharacter.join_time),
        updateTime: new Date(rawCharacter.update_time),
        exp: rawCharacter.exp,
        stack: rawCharacter.stack,
        manaBoardIndex: rawCharacter.mana_board_index,
        exBoost: buildPlayerCharacterExBoost(rawCharacter.ex_boost_status_id, rawCharacter.ex_boost_ability_id_list),
        illustrationSettings: rawCharacter.illustration_settings === null ? undefined : deserializeNumberList(rawCharacter.illustration_settings),
        bondTokenList: bondTokens
    }
}

/**
 * Checks whether a player owns a given character or not.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @returns A boolean, stating whether the player owns the character.
 */
export function playerOwnsCharacterSync(
    playerId: number,
    characterId: number
): boolean {
    return getDb().prepare(`
    SELECT id
    FROM players_characters
    WHERE player_id = ? AND id = ?
    `).get(playerId, characterId) !== undefined
}

/**
 * Gets a singular character from a player's data.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @returns The PlayerCharacter or null if it doesn't exist.
 */
export function getPlayerCharacterSync(
    playerId: number,
    characterId: number
): PlayerCharacter | null {

    const rawCharacter = getDb().prepare(`
    SELECT id, entry_count, evolution_level, over_limit_step, protection,
        join_time, update_time, exp, stack, mana_board_index, ex_boost_status_id,
        ex_boost_ability_id_list, illustration_settings
    FROM players_characters
    WHERE player_id = ? AND id = ?
    `).get(playerId, characterId) as RawPlayerCharacter

    if (rawCharacter === undefined) return null

    // get bond tokens
    const rawBondTokens = getDb().prepare(`
    SELECT mana_board_index, status, character_id
    FROM players_characters_bond_tokens
    WHERE player_id = ? AND character_id = ?
    `).all(playerId, characterId) as RawPlayerCharacterBondToken[]

    return buildPlayerCharacter(
        rawCharacter,
        rawBondTokens.map(raw => buildCharacterBondToken(raw))
    )
}

/** Reads bond tokens by character, with a stable SQL order for projections and diagnostics. */
export function getPlayerCharacterBondTokensByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, PlayerCharacterBondToken[]> {
    const characterIds = normalizeCharacterFactIds(ids)
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT character_id, mana_board_index, status
        FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id IN (${placeholders})
        ORDER BY character_id, mana_board_index
    `).all(playerId, ...characterIds) as RawPlayerCharacterBondToken[]
    const buckets: Record<string, PlayerCharacterBondToken[]> = {}
    for (const row of rows) {
        ;(buckets[String(row.character_id)] ??= []).push({
            manaBoardIndex: row.mana_board_index,
            status: row.status,
        })
    }
    return buckets
}

export function getPlayerCharacterBondTokensSync(
    playerId: number,
    characterId: number,
): PlayerCharacterBondToken[] {
    return getPlayerCharacterBondTokensByIdsSync(playerId, [characterId])[String(characterId)] ?? []
}

export function getPlayerCharacterGrowthFactsByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, PlayerCharacterGrowthFact> {
    const characterIds = normalizeCharacterFactIds(ids)
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT id, exp
        FROM players_characters
        WHERE player_id = ? AND id IN (${placeholders})
    `).all(playerId, ...characterIds) as { id: number, exp: number }[]
    return Object.fromEntries(rows.map(row => [String(row.id), {
        exp: row.exp,
    }]))
}

/**
 * Gets a list of all of the characters that a player owns.
 * 
 * @param playerId The ID of the player.
 * @returns A list of the characters that the player owns.
 */
export function getPlayerCharactersSync(
    playerId: number
): Record<string, PlayerCharacter> {

    const rawCharacters = getDb().prepare(`
    SELECT id, entry_count, evolution_level, over_limit_step, protection,
        join_time, update_time, exp, stack, mana_board_index, ex_boost_status_id,
        ex_boost_ability_id_list, illustration_settings
    FROM players_characters
    WHERE player_id = ?
    `).all(playerId) as RawPlayerCharacter[]

    // get bond tokens
    const rawBondTokens = getDb().prepare(`
    SELECT mana_board_index, status, character_id
    FROM players_characters_bond_tokens
    WHERE player_id = ?
    `).all(playerId) as RawPlayerCharacterBondToken[]

    const bondBuckets: Record<string, PlayerCharacterBondToken[]> = {}

    for (const rawBondToken of rawBondTokens) {
        const characterId = rawBondToken.character_id.toString()
        let bucket = bondBuckets[characterId]
        if (!bucket) {
            bucket = []
            bondBuckets[characterId] = bucket
        }

        bucket.push(buildCharacterBondToken(rawBondToken))
    }

    const out: Record<string, PlayerCharacter> = {}

    for (const rawCharacter of rawCharacters) {
        const id = rawCharacter.id.toString()
        out[id] = buildPlayerCharacter(
            rawCharacter,
            bondBuckets[id] || []
        )
    }

    return out
}

export function getPlayerCharactersByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, PlayerCharacter> {
    const characterIds = normalizeCharacterFactIds(ids)
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rawCharacters = getDb().prepare(`
    SELECT id, entry_count, evolution_level, over_limit_step, protection,
        join_time, update_time, exp, stack, mana_board_index, ex_boost_status_id,
        ex_boost_ability_id_list, illustration_settings
    FROM players_characters
    WHERE player_id = ? AND id IN (${placeholders})
    `).all(playerId, ...characterIds) as RawPlayerCharacter[]
    const rawBondTokens = getDb().prepare(`
    SELECT mana_board_index, status, character_id
    FROM players_characters_bond_tokens
    WHERE player_id = ? AND character_id IN (${placeholders})
    `).all(playerId, ...characterIds) as RawPlayerCharacterBondToken[]
    const bondBuckets: Record<string, PlayerCharacterBondToken[]> = {}
    for (const raw of rawBondTokens) {
        const id = String(raw.character_id)
        ;(bondBuckets[id] ??= []).push(buildCharacterBondToken(raw))
    }
    return Object.fromEntries(rawCharacters.map(raw => [String(raw.id), buildPlayerCharacter(
        raw,
        bondBuckets[String(raw.id)] ?? [],
    )]))
}

/**
 * Inserts a single character's bond token into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @param bondToken The bond token to insert.
 */
export function insertPlayerCharacterBondTokenSync(
    playerId: number,
    characterId: number | string,
    bondToken: PlayerCharacterBondToken
) {
    getDb().prepare(`
    INSERT INTO players_characters_bond_tokens (mana_board_index, status, player_id, character_id)
    VALUES (?, ?, ?, ?)
    `).run(
        bondToken.manaBoardIndex,
        bondToken.status,
        playerId,
        Number(characterId)
    )
}

/**
 * Updates a player's character's bond token.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @param bondToken The updated bondToken.
 */
export function updatePlayerCharacterBondTokenSync(
    playerId: number,
    characterId: number | string,
    bondToken: PlayerCharacterBondToken
) {
    getDb().prepare(`
    UPDATE players_characters_bond_tokens
    SET status = ?
    WHERE player_id = ? AND character_id = ? AND mana_board_index = ?
    `).run(
        bondToken.status,
        playerId,
        Number(characterId),
        bondToken.manaBoardIndex
    )
}

/**
 * Inserts a single character into a player's inventory.
 * 
 * @param playerId The ID of the player to add the character to.
 * @param characterId The ID of the character to add.
 * @param character The character data.
 */
export function insertPlayerCharacterSync(
    playerId: number,
    characterId: number | string,
    character: PlayerCharacter
) {
    // insert into characters table
    getDb().prepare(`
    INSERT INTO players_characters (id, entry_count, evolution_level, over_limit_step, 
        protection, join_time, update_time, exp, stack, mana_board_index, player_id,
        ex_boost_status_id, ex_boost_ability_id_list, illustration_settings)
    VALUES (
        @id, @entry_count, @evolution_level, @over_limit_step, @protection,
        @join_time, @update_time, @exp, @stack, @mana_board_index, @player_id,
        @ex_boost_status_id, @ex_boost_ability_id_list, @illustration_settings
    )
    `).run({
        id: Number(characterId),
        entry_count: character.entryCount,
        evolution_level: character.evolutionLevel,
        over_limit_step: character.overLimitStep,
        protection: serializeBoolean(character.protection),
        join_time: character.joinTime.toISOString(),
        update_time: character.updateTime.toISOString(),
        exp: character.exp,
        stack: character.stack,
        mana_board_index: character.manaBoardIndex,
        player_id: playerId,
        ex_boost_status_id: character.exBoost?.statusId ?? null,
        ex_boost_ability_id_list: character.exBoost?.abilityIdList === undefined
            ? null : serializeNumberList(character.exBoost.abilityIdList),
        illustration_settings: character.illustrationSettings === undefined
            ? null : serializeNumberList(character.illustrationSettings),
    })

    // insert mana board nodes
    for (const token of character.bondTokenList) {
        insertPlayerCharacterBondTokenSync(playerId, characterId, token)
    }
}

/**
 * Inserts a default single character into a player's inventory.
 * 
 * @param playerId The ID of the player to add the character to.
 * @param characterId The ID of the character to add.
 */
export function insertDefaultPlayerCharacterSync(
    playerId: number,
    characterId: number | string
) {
    const dateNow = getRealNow()

    const bondTokenList = [
        {
            manaBoardIndex: 1,
            status: 0
        }
    ]

    const assetData = getCharacterDataSync(characterId)
    if (assetData && assetData.skill_count > 3) {
        bondTokenList.push({
            manaBoardIndex: 2,
            status: 0
        })
    }

    insertPlayerCharacterSync(
        playerId,
        characterId,
        {
            entryCount: 1,
            evolutionLevel: 0,
            overLimitStep: 0,
            protection: false,
            joinTime: dateNow,
            updateTime: dateNow,
            exp: 0,
            stack: 0,
            manaBoardIndex: 1,
            bondTokenList: bondTokenList
        }
    )
}

/**
 * Batch inserts a record of characters into a player's inventory.
 * 
 * @param playerId The ID of the player.
 * @param characters The record of characters to insert.
 */
export function insertPlayerCharactersSync(
    playerId: number,
    characters: Record<string, PlayerCharacter>
) {
    getDb().transaction(() => {
        for (const [characterId, data] of Object.entries(characters)) {
            insertPlayerCharacterSync(playerId, characterId, data)
        }
    })()
}

/**
 * Updates a single character within a player's data.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @param character The partial data of the character to update.
 */
export function updatePlayerCharacterSync(
    playerId: number,
    characterId: number,
    character: Partial<PlayerCharacter>
) {
    const fieldMap: Record<string, string> = {
        'entryCount': 'entry_count',
        'evolutionLevel': 'evolution_level',
        'overLimitStep': 'over_limit_step',
        'protection': 'protection',
        'joinTime': 'join_time',
        'updateTime': 'update_time',
        'exp': 'exp',
        'stack': 'stack',
        'manaBoardIndex': 'mana_board_index'
    }

    // set the update time to now
    character.updateTime = getRealNow()

    const sets: string[] = []
    const values: any[] = []
    for (const key in character) {
        const value = character[key as keyof PlayerCharacter]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (value instanceof Date) {
                values.push(value.toISOString())
            } else if (typeof (value) === "boolean") {
                values.push(serializeBoolean(value))
            } else {
                values.push(value)
            }
        }
    }

    const exBoost = character.exBoost
    if (exBoost !== undefined) {
        sets.push('ex_boost_status_id = ?')
        sets.push('ex_boost_ability_id_list = ?')
        values.push(exBoost.statusId)
        values.push(serializeNumberList(exBoost.abilityIdList))
    }

    const illustration_settings = character.illustrationSettings
    if (illustration_settings !== undefined) {
        sets.push('illustration_settings = ?')
        values.push(serializeNumberList(illustration_settings))
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players_characters
        SET ${sets.join(', ')}
        WHERE id = ? AND player_id = ?
        `).run([...values, characterId, playerId]);
}

/**
 * Retrieves the mana node statuses of a player's characters.
 * 
 * @param playerId The ID of the player.
 * @returns A record containing the statuses of the player's characters.
 */
export function getPlayerCharactersManaNodesSync(
    playerId: number
): Record<string, number[]> {

    const rawNodes = getDb().prepare(`
    SELECT value, character_id
    FROM players_characters_mana_nodes
    WHERE player_id = ?
    `).all(playerId) as RawPlayerCharacterManaNode[]

    const buckets: Record<string, number[]> = {}

    for (const rawNode of rawNodes) {
        const characterId = rawNode.character_id.toString()
        let bucket: number[] = buckets[characterId]
        if (!bucket) {
            bucket = []
            buckets[characterId] = bucket
        }

        bucket.push(rawNode.value)
    }

    return buckets
}

/**
 * Gets all of the mana nodes that a player has unlocked for a specific character.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character.
 * @returns A list of unlocked mana node ids.
 */
export function getPlayerCharacterManaNodesSync(
    playerId: number,
    characterId: number
): number[] {
    const rawNodes = getDb().prepare(`
    SELECT value, character_id
    FROM players_characters_mana_nodes
    WHERE character_id = ? AND player_id = ?
    `).all(characterId, playerId) as RawPlayerCharacterManaNode[]

    return rawNodes.map(rawNode => rawNode.value);
}

export function getPlayerCharacterManaNodesByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, number[]> {
    const characterIds = normalizeCharacterFactIds(ids)
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rawNodes = getDb().prepare(`
        SELECT value, character_id
        FROM players_characters_mana_nodes
        WHERE player_id = ? AND character_id IN (${placeholders})
    `).all(playerId, ...characterIds) as RawPlayerCharacterManaNode[]
    const buckets: Record<string, number[]> = {}
    for (const rawNode of rawNodes) {
        const characterId = String(rawNode.character_id)
        const bucket = buckets[characterId] ?? []
        bucket.push(rawNode.value)
        buckets[characterId] = bucket
    }
    return buckets
}

/** Returns one character's learned mana nodes with their persisted awake levels. */
export function getPlayerCharacterManaNodeAwakeLevelsSync(
    playerId: number,
    characterId: number,
): Record<number, number> {
    const rawNodes = getDb().prepare(`
    SELECT value, awake_level
    FROM players_characters_mana_nodes
    WHERE character_id = ? AND player_id = ?
    `).all(characterId, playerId) as RawPlayerCharacterManaNode[]

    return Object.fromEntries(rawNodes.map(rawNode => [
        rawNode.value,
        rawNode.awake_level ?? 0,
    ]))
}

/**
 * Checks whether a player has unlocked a specific mana node.
 * 
 * @param playerId The ID of the player to check.
 * @param characterId The ID of the character.
 * @param manaNodeId The ID of the mana node.
 * @returns Whether the specified mana node has been unlocked or not.
 */
export function hasPlayerUnlockedCharacterManaNodeSync(
    playerId: number,
    characterId: number,
    manaNodeId: string | number
): boolean {
    return getDb().prepare(`
    SELECT value
    FROM players_characters_mana_nodes
    WHERE player_id = ? AND character_id = ? AND value = ?
    `).get(playerId, characterId, Number(manaNodeId)) !== undefined
}

/**
 * Inserts mana nodes for a particular character into the database.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character to insert the mana nodes of.
 * @param manaNodes The mana nodes values to insert.
 */
export const MAX_MANA_NODE_BATCH_SIZE = Math.floor(32766 / 3)

export function insertPlayerCharacterManaNodesSync(
    playerId: number,
    characterId: number | string,
    manaNodes: readonly number[]
) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer.")
    }
    const normalizedCharacterId = Number(characterId)
    if (!Number.isSafeInteger(normalizedCharacterId) || normalizedCharacterId <= 0) {
        throw new TypeError("characterId must be a positive safe integer.")
    }
    const nodes = [...new Set(manaNodes)]
    for (const nodeId of nodes) {
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
            throw new TypeError("nodeId must be a positive safe integer.")
        }
    }
    if (nodes.length > MAX_MANA_NODE_BATCH_SIZE) {
        throw new RangeError(
            `mana node batch cannot exceed ${MAX_MANA_NODE_BATCH_SIZE} unique nodes.`,
        )
    }
    if (nodes.length === 0) return

    const values = nodes.map(() => "(?, ?, ?)").join(", ")
    const parameters = nodes.flatMap(nodeId => [nodeId, normalizedCharacterId, playerId])
    getDb().prepare(`
        INSERT INTO players_characters_mana_nodes (value, character_id, player_id)
        VALUES ${values}
    `).run(...parameters)
}

/**
 * Batch inserts a record of characters' mana nodes into the database.
 * 
 * @param playerId The ID of the player.
 * @param charactersManaNodes The record of character mana node values.
 */
export function insertPlayerCharactersManaNodesSync(
    playerId: number,
    charactersManaNodes: Record<string, number[]>
) {
    getDb().transaction(() => {
        for (const [characterId, manaNodes] of Object.entries(charactersManaNodes)) {
            insertPlayerCharacterManaNodesSync(playerId, characterId, manaNodes)
        }
    })()
}

/**
 * Gets the awake_level values for all mana nodes owned by a player.
 * 
 * @param playerId The ID of the player.
 * @returns A record mapping character_id → { node_id → awake_level }.
 */
export function getPlayerCharactersManaNodeAwakeLevelsSync(
    playerId: number
): Record<string, Record<number, number>> {
    const rawNodes = getDb().prepare(`
    SELECT value, character_id, awake_level
    FROM players_characters_mana_nodes
    WHERE player_id = ?
    `).all(playerId) as RawPlayerCharacterManaNode[]

    const result: Record<string, Record<number, number>> = {}
    for (const rawNode of rawNodes) {
        const charId = rawNode.character_id.toString()
        if (!result[charId]) result[charId] = {}
        result[charId][rawNode.value] = rawNode.awake_level ?? 0
    }
    return result
}

export function getPlayerCharactersManaNodeAwakeLevelsByIdsSync(
    playerId: number,
    ids: readonly number[],
): Record<string, Record<number, number>> {
    const characterIds = normalizeCharacterFactIds(ids)
    if (characterIds.length === 0) return {}
    const placeholders = characterIds.map(() => "?").join(", ")
    const rawNodes = getDb().prepare(`
    SELECT value, character_id, awake_level
    FROM players_characters_mana_nodes
    WHERE player_id = ? AND character_id IN (${placeholders})
    `).all(playerId, ...characterIds) as RawPlayerCharacterManaNode[]
    const result: Record<string, Record<number, number>> = {}
    for (const rawNode of rawNodes) {
        const characterId = String(rawNode.character_id)
        ;(result[characterId] ??= {})[rawNode.value] = rawNode.awake_level ?? 0
    }
    return result
}

export function hasPlayerCharacterManaNodeAwakeProgressSync(
    playerId: number,
    characterId: number
): boolean {
    return getDb().prepare(`
    SELECT 1
    FROM players_characters_mana_nodes
    WHERE player_id = ? AND character_id = ? AND awake_level > 0
    LIMIT 1
    `).get(playerId, characterId) !== undefined
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

/**
 * Updates the awake_level for a player's character mana node.
 * Only updates nodes that already exist from learn_mana_node.
 * 
 * @param playerId The ID of the player.
 * @param characterId The character's ID.
 * @param manaNodeId The mana node multiplied_id.
 * @param awakeLevel The new awake_level to set.
 */
export function updatePlayerCharacterManaNodeAwakeLevelSync(
    playerId: number,
    characterId: number,
    manaNodeId: number,
    awakeLevel: number
): boolean {
    return getDb().prepare(`
    UPDATE players_characters_mana_nodes
    SET awake_level = ?
    WHERE value = ? AND character_id = ? AND player_id = ?
    `).run(awakeLevel, manaNodeId, characterId, playerId).changes > 0
}

export interface PlayerCharacterManaNodeAwakeUpdate {
    readonly nodeId: number
    readonly awakeLevel: number
}

export function updatePlayerCharacterManaNodeAwakeLevelsBatchSync(
    playerId: number,
    characterId: number,
    updates: readonly PlayerCharacterManaNodeAwakeUpdate[],
): void {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
        throw new TypeError("characterId must be a positive safe integer.")
    }

    const uniqueUpdates = new Map<number, number>()
    for (const update of updates) {
        if (!Number.isSafeInteger(update?.nodeId) || update.nodeId <= 0) {
            throw new TypeError("nodeId must be a positive safe integer.")
        }
        if (!Number.isSafeInteger(update.awakeLevel) || update.awakeLevel < 0) {
            throw new TypeError("awakeLevel must be a non-negative safe integer.")
        }
        const existingAwakeLevel = uniqueUpdates.get(update.nodeId)
        if (existingAwakeLevel !== undefined && existingAwakeLevel !== update.awakeLevel) {
            throw new TypeError(`nodeId ${update.nodeId} has conflicting awake levels.`)
        }
        uniqueUpdates.set(update.nodeId, update.awakeLevel)
    }
    if (uniqueUpdates.size > MAX_MANA_NODE_BATCH_SIZE) {
        throw new RangeError(
            `mana node batch cannot exceed ${MAX_MANA_NODE_BATCH_SIZE} unique nodes.`,
        )
    }
    if (uniqueUpdates.size === 0) return

    const values = [...uniqueUpdates].map(() => "(?, ?)").join(", ")
    const parameters = [...uniqueUpdates].flatMap(([nodeId, awakeLevel]) => [nodeId, awakeLevel])
    const db = getDb()
    db.transaction(() => {
        const result = db.prepare(`
            WITH node_updates(node_id, awake_level) AS (
                VALUES ${values}
            )
            UPDATE players_characters_mana_nodes
            SET awake_level = (
                SELECT node_updates.awake_level
                FROM node_updates
                WHERE node_updates.node_id = players_characters_mana_nodes.value
            )
            WHERE player_id = ? AND character_id = ?
                AND value IN (SELECT node_id FROM node_updates)
        `).run(...parameters, playerId, characterId)
        if (result.changes !== uniqueUpdates.size) {
            throw new Error(
                `awake mana node batch updated ${result.changes} of ${uniqueUpdates.size} persisted nodes`,
            )
        }
    })()
}

export function updatePlayerCharactersManaNodeAwakeLevelsSync(
    playerId: number,
    awakeLevels: Record<string, Record<number, number>>
): void {
    if (!isPlainObject(awakeLevels)) {
        throw new TypeError("characterManaNodeAwakeLevels must be a plain object.")
    }

    const validated: { characterId: number; manaNodeId: number; awakeLevel: number }[] = []
    const characterIds = new Set<number>()
    for (const [characterKey, rawNodeLevels] of Object.entries(awakeLevels)) {
        const characterId = parsePositiveSafeIntegerKey(
            characterKey,
            "characterManaNodeAwakeLevels characterId",
        )
        characterIds.add(characterId)
        if (!isPlainObject(rawNodeLevels)) {
            throw new TypeError(`characterManaNodeAwakeLevels[${characterId}] must be a plain object.`)
        }
        for (const [nodeKey, awakeLevel] of Object.entries(rawNodeLevels)) {
            const manaNodeId = parsePositiveSafeIntegerKey(
                nodeKey,
                `characterManaNodeAwakeLevels[${characterId}] manaNodeId`,
            )
            if (!Number.isSafeInteger(awakeLevel) || (awakeLevel as number) < 0) {
                throw new TypeError(
                    `characterManaNodeAwakeLevels[${characterId}][${manaNodeId}] awakeLevel must be a non-negative safe integer.`,
                )
            }
            validated.push({ characterId, manaNodeId, awakeLevel: awakeLevel as number })
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
                    `characterManaNodeAwakeLevels references unknown character ${characterId}.`,
                )
            }
        }
        for (const entry of validated) {
            if (!updatePlayerCharacterManaNodeAwakeLevelSync(
                playerId,
                entry.characterId,
                entry.manaNodeId,
                entry.awakeLevel,
            )) {
                throw new Error(
                    `characterManaNodeAwakeLevels references unknown character/node ${entry.characterId}/${entry.manaNodeId}.`,
                )
            }
        }
    })()
}
