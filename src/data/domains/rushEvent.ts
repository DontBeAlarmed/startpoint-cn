import { getDb } from "../db";
import { PlayerRushEvent, RawPlayerRushEvent, PlayerRushEventClearedFolders, RawPlayerRushEventClearedFolder, PlayerRushEventPlayedParty, RawPlayerRushEventPlayedParty, RawPlayerRushEventRanking, RushEventBattleType, GetRushEventEndlessRankingListResult, UserRushEventEndlessBattleRanking, UserRushEventPlayedParty } from "../types";
import { serializeBoolean, deserializeBoolean, deserializeNumberList } from "../utils";
import { getServerTime } from "../../utils";
import { getPlayerRushEventEndlessBattleRankingSync } from "../../lib/rush";

/**
 * Deserializes a RawPlayerRushEvent into a PlayerRushEvent
 * 
 * @param raw 
 * @param endlessBattleNextRound The next endless battle round for this event.
 */
export function deserializeRushEvent(
    raw: RawPlayerRushEvent,
    endlessBattleNextRound: number
): PlayerRushEvent {
    return {
        eventId: raw.event_id,
        endlessBattleNextRound: endlessBattleNextRound,
        activeRushBattleFolderId: raw.active_rush_battle_folder_id,
        endlessBattleMaxRound: raw.endless_battle_max_round,
        endlessBattleMaxRoundTime: raw.endless_battle_max_round_time,
        endlessBattleMaxRoundCharacterIds: [
            raw.endless_battle_max_round_character_id_1,
            raw.endless_battle_max_round_character_id_2,
            raw.endless_battle_max_round_character_id_3
        ],
        endlessBattleMaxRoundCharacterEvolutionImgLvls: [
            raw.endless_battle_max_round_character_evolution_img_lvl_1,
            raw.endless_battle_max_round_character_evolution_img_lvl_2,
            raw.endless_battle_max_round_character_evolution_img_lvl_3,
        ]
    }
}

/**
 * Returns a default PlayerRushEvent.
 * 
 * @param eventId The ID of the event to get the default PlayerRushEvent of.
 * @returns A default PlayerRushEvent
 */
export function getDefaultPlayerRushEventSync(
    eventId: number
): PlayerRushEvent {
    return {
        eventId: eventId,
        endlessBattleNextRound: 1,
        activeRushBattleFolderId: null,
        endlessBattleMaxRound: null,
        endlessBattleMaxRoundTime: null,
        endlessBattleMaxRoundCharacterIds: [null, null, null],
        endlessBattleMaxRoundCharacterEvolutionImgLvls: [null, null, null]
    }
}

/**
 * Gets the data for a player's rush event progress.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @returns The rush event data or null.
 */
export function getPlayerRushEventSync(
    playerId: number,
    eventId: number
): PlayerRushEvent | null {

    const rawData = getDb().prepare(`
    SELECT *
    FROM players_rush_events
    WHERE player_id = ? AND event_id = ?
    `).get(playerId, eventId) as RawPlayerRushEvent

    // get next endless round
    const nextEndlessBattleRound = getPlayerRushEventNextEndlessBattleRoundSync(playerId, eventId)

    return rawData === undefined ? null : deserializeRushEvent(rawData, nextEndlessBattleRound)
}

/**
 * Batch gets the data for every rush event a player has participated in.
 * 
 * @param playerId The ID of the player.
 * @returns An array of PlayerRushEvent objects.
 */
export function getPlayerRushEventListSync(
    playerId: number
): PlayerRushEvent[] {
    const rawData = getDb().prepare(`
    SELECT *
    FROM players_rush_events
    WHERE player_id = ?
    `).all(playerId) as RawPlayerRushEvent[]

    return rawData.map(raw => deserializeRushEvent(raw, 1))
}

/**
 * Gets rush event endless battle rankings for a specific rush event.
 * 
 * @param eventId The rush event's ID.
 * @param page The current page.
 * @param pageSize The size of each page.
 * @returns The ranking list result.
 */
export function getRushEventEndlessRankingListSync(
    eventId: number,
    page: number,
    pageSize: number = 100
): GetRushEventEndlessRankingListResult {
    const offset = page * pageSize

    const results = getDb().prepare(`
    SELECT *,
        COUNT(*) OVER() as total_count
    FROM players_rush_events
    WHERE event_id = ?
    ORDER BY endless_battle_max_round DESC,
        endless_battle_max_round_time ASC
    LIMIT ?
    OFFSET ?
    `).all(
        eventId,
        pageSize,
        offset
    ) as RawPlayerRushEventRanking[]

    const totalCount = results[0]?.total_count ?? 0;

    const mappedResults: UserRushEventEndlessBattleRanking[] = []
    let rankNumber = 1;

    for (const raw of results) {
        const ranking = getPlayerRushEventEndlessBattleRankingSync(raw.player_id, eventId, {
            rankNumber: rankNumber + offset
        })
        if (ranking !== null) {
            mappedResults.push(ranking)
            rankNumber += 1;
        }
    }
    
    return {
        pageMax: Math.ceil(totalCount / pageSize),
        list: mappedResults
    }
}

/**
 * Gets the player ID who is at a specific rank for the endless battle leaderboard for a raid event.
 * 
 * @param rank The rank to get the player ID of.
 * @param eventId The ID of the rush event.
 * @returns A player ID or null.
 */
export function getPlayerIdFromRushEventEndlessRankSync(
    rank: number,
    eventId: number
): number | null {
    const result = getDb().prepare(`
    SELECT player_id
    FROM players_rush_events
    WHERE event_id = ?
    ORDER BY endless_battle_max_round DESC,
        endless_battle_max_round_time ASC
    LIMIT 1
    OFFSET ?
    `).get(
        eventId,
        rank - 1
    ) as { player_id: number } | undefined

    return result?.player_id ?? null
}

/**
 * Inserts the data for a player's rush event progress.
 * 
 * @param playerId The ID of the player.
 * @param rushEvent The data of the rush event to insert.
 */
export function insertPlayerRushEventSync(
    playerId: number,
    rushEvent: PlayerRushEvent
) {
    getDb().prepare(`
    INSERT INTO players_rush_events
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        playerId,
        rushEvent.eventId,
        rushEvent.activeRushBattleFolderId,
        rushEvent.endlessBattleMaxRound,
        rushEvent.endlessBattleMaxRoundTime,
        ...rushEvent.endlessBattleMaxRoundCharacterIds,
        ...rushEvent.endlessBattleMaxRoundCharacterEvolutionImgLvls
    )
}

/**
 * Batch inserts a player's data for multiple rush events into the database.
 * 
 * @param playerId The ID of the player.
 * @param eventList An array of rush event data entries.
 */
export function insertPlayerRushEventListSync(
    playerId: number,
    eventList: PlayerRushEvent[]
) {
    getDb().transaction(() => {
        for (const event of eventList) {
            insertPlayerRushEventSync(playerId, event)
        }
    })()
}

/**
 * Updates the data for a player's rush event progress.
 * 
 * @param playerId The ID of the player.
 * @param rushEvent The values to change.
 */
export function updatePlayerRushEventSync(
    playerId: number,
    rushEvent: Partial<PlayerRushEvent> & Pick<PlayerRushEvent, 'eventId'>
) {

    const characterIds = rushEvent.endlessBattleMaxRoundCharacterIds
    const characterEvolutionImgLevels = rushEvent.endlessBattleMaxRoundCharacterEvolutionImgLvls

    const fields: Record<string, any> = {
        'active_rush_battle_folder_id': rushEvent.activeRushBattleFolderId,
        'endless_battle_max_round': rushEvent.endlessBattleMaxRound,
        'endless_battle_max_round_time': rushEvent.endlessBattleMaxRoundTime,
        'endless_battle_max_round_character_id_1': characterIds?.[0],
        'endless_battle_max_round_character_id_2': characterIds?.[1],
        'endless_battle_max_round_character_id_3': characterIds?.[2],
        'endless_battle_max_round_character_evolution_img_lvl_1': characterEvolutionImgLevels?.[0],
        'endless_battle_max_round_character_evolution_img_lvl_2': characterEvolutionImgLevels?.[1],
        'endless_battle_max_round_character_evolution_img_lvl_3': characterEvolutionImgLevels?.[2],
    }

    const sets: string[] = []
    const values: any[] = []
    for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined) {
            sets.push(`${field} = ?`)
            values.push(value)
        }
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players_rush_events
        SET ${sets.join(', ')}
        WHERE player_id = ? AND event_id = ?
        `).run([
        ...values,
        playerId,
        rushEvent.eventId
    ]);
}

/**
 * Gets all of the folders that a player has cleared for a specific rush event.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @returns An array of cleared folder IDs.
 */
export function getPlayerRushEventClearedFoldersSync(
    playerId: number,
    eventId: number
): PlayerRushEventClearedFolders {
    const rawCleared = getDb().prepare(`
    SELECT player_id, event_id, folder_id
    FROM players_rush_events_cleared_folders
    WHERE player_id = ? AND event_id = ?
    `).all(playerId, eventId) as RawPlayerRushEventClearedFolder[]

    return rawCleared.map(raw => raw.folder_id)
}

/**
 * Gets all of the cleared folders for every rush event.
 * 
 * @param playerId The ID of the player.
 * @returns A record where the key is the event ID and the value is an array of cleared folder IDs.
 */
export function getPlayerRushEventListClearedFoldersSync(
    playerId: number
): Record<string, PlayerRushEventClearedFolders> {
    const rawCleared = getDb().prepare(`
    SELECT player_id, event_id, folder_id
    FROM players_rush_events_cleared_folders
    WHERE player_id = ?
    `).all(playerId) as RawPlayerRushEventClearedFolder[]

    const eventFolderBuckets: Record<string, PlayerRushEventClearedFolders> = {}
    for (const clearedFolder of rawCleared) {
        let bucket: PlayerRushEventClearedFolders | undefined = eventFolderBuckets[clearedFolder.event_id]
        if (bucket === undefined) {
            bucket = []
            eventFolderBuckets[clearedFolder.event_id] = bucket
        }
        bucket.push(clearedFolder.folder_id)
    }

    return eventFolderBuckets
}

/**
 * Marks a rush event's folder as cleared for a specific player.
 * 
 * @param playerId The ID of the player
 * @param eventId The ID of the rush event.
 * @param folderId The ID of the cleared folder.
 */
export function insertPlayerRushEventClearedFolderSync(
    playerId: number,
    eventId: number,
    folderId: number
) {
    getDb().prepare(`
    INSERT OR IGNORE INTO players_rush_events_cleared_folders (player_id, event_id, folder_id)
    VALUES (?, ?, ?)
    `).run(playerId, eventId, folderId)
}

/**
 * Batch inserts multiple cleared folder IDs into the database.
 * 
 * @param playerId The ID of the player.
 * @param folderList A record where the key is the ID of a rush event and the value is an array of folder IDs.
 */
export function insertPlayerRushEventClearedFolderListSync(
    playerId: number,
    folderList: Record<string, PlayerRushEventClearedFolders>
) {
    getDb().transaction(() => {
        for (const [rawEventId, folders] of Object.entries(folderList)) {
            const eventId = Number(rawEventId)
            for (const folderId of folders) {
                insertPlayerRushEventClearedFolderSync(playerId, eventId, folderId)
            }
        }
    })()
}

/**
 * Converts a PlayerRushEventPlayedParty object from database format.
 * 
 * @param serialized The PlayerRushEventPlayedParty in database format.
 * @returns 
 */
export function deserializePlayerRushEventPlayedParty(
    serialized: RawPlayerRushEventPlayedParty
): PlayerRushEventPlayedParty {
    return {
        characterIds: [
            serialized.character_id_1,
            serialized.character_id_2,
            serialized.character_id_3
        ],
        unisonCharacterIds: [
            serialized.unison_character_id_1,
            serialized.unison_character_id_2,
            serialized.unison_character_id_3
        ],
        abilitySoulIds: [
            serialized.ability_soul_id_1,
            serialized.ability_soul_id_2,
            serialized.ability_soul_id_3
        ],
        equipmentIds: [
            serialized.equipment_id_1,
            serialized.equipment_id_2,
            serialized.equipment_id_3
        ],
        evolutionImgLevels: [
            serialized.evolution_img_level_1,
            serialized.evolution_img_level_2,
            serialized.evolution_img_level_3
        ],
        unisonEvolutionImgLevels: [
            serialized.unison_evolution_img_level_1,
            serialized.unison_evolution_img_level_2,
            serialized.unison_evolution_img_level_3
        ],
        battleType: serialized.battle_type,
        round: serialized.round
    }
}

/**
 * Converts a PlayerRushEventPlayedParty into database format.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @param deserialized The deserialized rush party to convert.
 * @returns A RawPlayerRushEventPlayedParty
 */
export function serializePlayerRushEventPlayedParty(
    deserialized: PlayerRushEventPlayedParty
): UserRushEventPlayedParty {
    return {
        character_id_1: deserialized.characterIds[0],
        character_id_2: deserialized.characterIds[1],
        character_id_3: deserialized.characterIds[2],
        unison_character_id_1: deserialized.unisonCharacterIds[0],
        unison_character_id_2: deserialized.unisonCharacterIds[1],
        unison_character_id_3: deserialized.unisonCharacterIds[2],
        equipment_id_1: deserialized.equipmentIds[0],
        equipment_id_2: deserialized.equipmentIds[1],
        equipment_id_3: deserialized.equipmentIds[2],
        ability_soul_id_1: deserialized.abilitySoulIds[0],
        ability_soul_id_2: deserialized.abilitySoulIds[1],
        ability_soul_id_3: deserialized.abilitySoulIds[2],
        evolution_img_level_1: deserialized.evolutionImgLevels[0],
        evolution_img_level_2: deserialized.evolutionImgLevels[1],
        evolution_img_level_3: deserialized.evolutionImgLevels[2],
        unison_evolution_img_level_1: deserialized.unisonEvolutionImgLevels[0],
        unison_evolution_img_level_2: deserialized.unisonEvolutionImgLevels[1],
        unison_evolution_img_level_3: deserialized.unisonEvolutionImgLevels[2],
    }
}

/**
 * Gets an array of all of a player's parties that they have used to clear rush events.
 * 
 * @param playerId The ID of the player.
 * @param eventId The event ID
 * @returns 
 */
export function getPlayerRushEventPlayedPartiesSync(
    playerId: number,
    eventId: number,
): PlayerRushEventPlayedParty[] {
    const rawParties = getDb().prepare(`
    SELECT character_id_1, character_id_2, character_id_3,
        unison_character_id_1, unison_character_id_2, unison_character_id_3,
        equipment_id_1, equipment_id_2, equipment_id_3, ability_soul_id_1,
        ability_soul_id_2, ability_soul_id_3, evolution_img_level_1,
        evolution_img_level_2, evolution_img_level_3,
        unison_evolution_img_level_1, unison_evolution_img_level_2,
        unison_evolution_img_level_3, player_id, event_id, round,
        battle_type
    FROM players_rush_events_played_parties
    WHERE player_id = ? AND event_id = ?
    `).all(playerId, eventId) as RawPlayerRushEventPlayedParty[]

    return rawParties.map(raw => deserializePlayerRushEventPlayedParty(raw))
}

/**
 * Batch gets a list of every played party for every rush event for a specific player.
 * 
 * @param playerId The ID of the player.
 * @returns A record where the key is an EventID and the value is an array of PlayerRushEventPlayedParty.
 */
export function getPlayerRushEventListPlayedPartiesSync(
    playerId: number
): Record<string, PlayerRushEventPlayedParty[]> {

    const rawParties = getDb().prepare(`
    SELECT *
    FROM players_rush_events_played_parties
    WHERE player_id = ?
    `).all(playerId) as RawPlayerRushEventPlayedParty[]

    const eventPartyBuckets: Record<string, PlayerRushEventPlayedParty[]> = {}
    for (const rawParty of rawParties) {
        let bucket: PlayerRushEventPlayedParty[] | undefined = eventPartyBuckets[rawParty.event_id]
        if (bucket === undefined) {
            bucket = []
            eventPartyBuckets[rawParty.event_id] = bucket
        }
        bucket.push(deserializePlayerRushEventPlayedParty(rawParty))
    }

    return eventPartyBuckets
}

/**
 * Gets the next endless battle round that a player should complete for a specific rush event.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @returns The next round that the player should complete.
 */
export function getPlayerRushEventNextEndlessBattleRoundSync(
    playerId: number,
    eventId: number
): number {
    const rawRounds = getDb().prepare(`
    SELECT round
    FROM players_rush_events_played_parties
    WHERE player_id = ? AND event_id = ? AND battle_type = ?
    `).all(
        playerId,
        eventId,
        RushEventBattleType.ENDLESS
    ) as { round: number }[]

    let nextRound: number = 1
    for (const rawRound of rawRounds) {
        if (rawRound.round !== nextRound) break;
        nextRound += 1
    }
    return nextRound
}

/**
 * Inserts a rush event played party for a specific player.
 * 
 * @param playerId The ID of the player.
 * @param eventId The rush event's ID.
 * @param party The party data.
 */
export function insertPlayerRushEventPlayedPartySync(
    playerId: number,
    eventId: number,
    party: PlayerRushEventPlayedParty
) {
    getDb().prepare(`
    INSERT INTO players_rush_events_played_parties
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        party.characterIds[0],
        party.characterIds[1],
        party.characterIds[2],
        party.unisonCharacterIds[0],
        party.unisonCharacterIds[1],
        party.unisonCharacterIds[2],
        party.equipmentIds[0],
        party.equipmentIds[1],
        party.equipmentIds[2],
        party.abilitySoulIds[0],
        party.abilitySoulIds[1],
        party.abilitySoulIds[2],
        party.evolutionImgLevels[0],
        party.evolutionImgLevels[1],
        party.evolutionImgLevels[2],
        party.unisonEvolutionImgLevels[0],
        party.unisonEvolutionImgLevels[1],
        party.unisonEvolutionImgLevels[2],
        playerId,
        eventId,
        party.round,
        party.battleType
    )
}

/**
 * Batch inserts PlayerRushEventPlayedParty values into the database.
 * 
 * @param playerId The ID of the player.
 * @param partyList A record where the key is an event ID, and the value is an array of rush event played parties.
 */
export function insertPlayerRushEventPlayedPartyListSync(
    playerId: number,
    partyList: Record<string, PlayerRushEventPlayedParty[]>
) {
    getDb().transaction(() => {
        for (const [rawEventId, parties] of Object.entries(partyList)) {
            const eventId = Number(rawEventId)
            for (const party of parties) {
                insertPlayerRushEventPlayedPartySync(playerId, eventId, party)
            }
        }
    })()
}

/**
 * Deletes all of a player's rush event played parties for a specific event & battle type.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @param battleType The type of rush event battle.
 */
export function deletePlayerRushEventPlayedPartyListSync(
    playerId: number,
    eventId: number,
    battleType: RushEventBattleType
) {
    getDb().prepare(`
    DELETE FROM players_rush_events_played_parties
    WHERE player_id = ? AND event_id = ? AND battle_type = ?
    `).run(
        playerId,
        eventId,
        battleType
    )
}

/**
 * Deletes a single rush event played party for a specific player & rush event.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @param round The round to delete.
 * @param battleType The type of rush event battle.
 */
export function deletePlayerRushEventPlayedPartySync(
    playerId: number,
    eventId: number,
    round: number,
    battleType: RushEventBattleType,
) {
    getDb().prepare(`
    DELETE FROM players_rush_events_played_parties
    WHERE player_id = ? AND event_id = ? AND round = ? AND battle_type = ?
    `).run(
        playerId,
        eventId,
        round,
        battleType
    )
}

/**
 * Deletes a player's rush event played parties while their round number is greater than or equal to the provided value.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @param battleType The type of rush event battle.
 * @param untilRound Delete parties until this round.
 */
export function deletePlayerRushEventPlayedPartiesUntilSync(
    playerId: number,
    eventId: number,
    battleType: RushEventBattleType,
    untilRound: number
) {
    getDb().prepare(`
    DELETE FROM players_rush_events_played_parties
    WHERE player_id = ? AND event_id = ? AND battle_type = ?
        AND round >= ?
    `).run(
        playerId,
        eventId,
        battleType,
        untilRound
    )
}

/**
 * Updates an existing rush event played party for a specific player & rush event.
 * 
 * @param playerId The player's ID.
 * @param eventId The ID of the rush event.
 * @param party The new party data.
 */
export function updatePlayerRushEventPlayedPartySync(
    playerId: number,
    eventId: number,
    party: PlayerRushEventPlayedParty
) {
    getDb().prepare(`
    UPDATE players_rush_events_played_parties
    SET character_id_1 = ?,
        character_id_2 = ?,
        character_id_3 = ?,
        unison_character_id_1 = ?,
        unison_character_id_2 = ?,
        unison_character_id_3 = ?,
        equipment_id_1 = ?,
        equipment_id_2 = ?,
        equipment_id_3 = ?,
        ability_soul_id_1 = ?,
        ability_soul_id_2 = ?,
        ability_soul_id_3 = ?,
        evolution_img_level_1 = ?,
        evolution_img_level_2 = ?,
        evolution_img_level_3 = ?,
        unison_evolution_img_level_1 = ?,
        unison_evolution_img_level_2 = ?,
        unison_evolution_img_level_3 = ?,
    WHERE player_id = ? AND event_id = ? AND round = ? AND battle_type = ?
    `).run(
        party.characterIds[0] ?? null,
        party.characterIds[1] ?? null,
        party.characterIds[2] ?? null,
        party.unisonCharacterIds[0] ?? null,
        party.unisonCharacterIds[1] ?? null,
        party.unisonCharacterIds[2] ?? null,
        party.equipmentIds[0] ?? null,
        party.equipmentIds[1] ?? null,
        party.equipmentIds[2] ?? null,
        party.abilitySoulIds[0] ?? null,
        party.abilitySoulIds[1] ?? null,
        party.abilitySoulIds[2] ?? null,
        party.evolutionImgLevels[0] ?? null,
        party.evolutionImgLevels[1] ?? null,
        party.evolutionImgLevels[2] ?? null,
        party.unisonEvolutionImgLevels[0] ?? null,
        party.unisonEvolutionImgLevels[1] ?? null,
        party.unisonEvolutionImgLevels[2] ?? null,
        playerId,
        eventId,
        party.round,
        party.battleType
    )
}

/**
 * Synchronously gets the first player bound to an account.
 */
