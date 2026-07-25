import { getDb } from "../db";
import { PlayerQuestProgress, PlayerDrawnQuest, RawPlayerQuestProgress, RawPlayerDrawnQuest } from "../types";
import { deserializeBoolean, serializeBoolean } from "../utils";

/**
 * Converts a RawPlayerQuestProgress object into a PlayerQuestProgress object.
 * 
 * @param raw The raw object to convert.
 * @returns The converted object.
 */
function buildPlayerQuestProgress(
    raw: RawPlayerQuestProgress
): PlayerQuestProgress {
    return {
        questId: raw.quest_id,
        finished: deserializeBoolean(raw.finished),
        unlocked: deserializeBoolean(raw.unlocked),
        highScore: raw.high_score,
        clearRank: raw.clear_rank,
        bestElapsedTimeMs: raw.best_elapsed_time_ms,
        leaderCharacterId: raw.leader_character_id,
        multiClearCount: raw.multi_clear_count,
        hostFinished: raw.host_finished === null || raw.host_finished === undefined
            ? undefined
            : deserializeBoolean(raw.host_finished),
    }
}

/**
 * Gets a player's overall quest progressfrom the database.
 * 
 * @param playerId The player's ID.
 * @returns A record where the index is the section and the value is a list of PlayerQuestProgress.
 */
export function getPlayerQuestProgressSync(
    playerId: number
): Record<string, PlayerQuestProgress[]> {

    const rawProgress = getDb().prepare(`
    SELECT section, quest_id, finished, unlocked, high_score, clear_rank, best_elapsed_time_ms, leader_character_id, multi_clear_count, host_finished
    FROM players_quest_progress
    WHERE player_id = ?
    `).all(playerId) as RawPlayerQuestProgress[]

    const mapped: Record<string, PlayerQuestProgress[]> = {}

    for (const raw of rawProgress) {
        const section = raw.section.toString()
        let bucket: PlayerQuestProgress[] = mapped[section]
        if (!bucket) {
            bucket = []
            mapped[section] = bucket
        }
        bucket.push(buildPlayerQuestProgress(raw))
    }

    return mapped
}

export function countFinishedPlayerQuestsByCategorySync(
    playerId: number,
    category: number,
): number {
    const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM players_quest_progress
    WHERE player_id = ? AND section = ? AND finished = 1
    `).get(playerId, category) as { count?: unknown } | undefined
    const count = Number(row?.count)
    return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export function getFinishedPlayerQuestIdsBySectionsSync(
    playerId: number,
    sections: readonly number[],
): Record<number, ReadonlySet<number>> {
    const normalizedSections = [...new Set(sections.map(Number))]
        .filter(section => Number.isSafeInteger(section))
    if (normalizedSections.length === 0) return {}

    const placeholders = normalizedSections.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT section, quest_id
        FROM players_quest_progress
        WHERE player_id = ? AND finished = 1 AND section IN (${placeholders})
    `).all(playerId, ...normalizedSections) as { section: number, quest_id: number }[]

    const result: Record<number, Set<number>> = {}
    for (const section of normalizedSections) result[section] = new Set<number>()
    for (const row of rows) result[row.section]?.add(row.quest_id)
    return result
}

/**
 * Gets the progress of a singular quest for a player..
 * 
 * @param playerId The ID of the player.
 * @param section The section of the quest.
 * @param questId The ID of the quest.
 * @returns The quest's progress data, or null if it doesn't exist.
 */
export function getPlayerSingleQuestProgressSync(
    playerId: number,
    section: number | string,
    questId: number | string
): PlayerQuestProgress | null {

    const rawProgress = getDb().prepare(`
    SELECT section, quest_id, finished, unlocked, high_score, clear_rank, best_elapsed_time_ms, leader_character_id, multi_clear_count, host_finished
    FROM players_quest_progress
    WHERE player_id = ? AND section = ? AND quest_id = ?
    `).get(playerId, Number(section), Number(questId)) as RawPlayerQuestProgress

    if (rawProgress === undefined) return null;

    return buildPlayerQuestProgress(rawProgress)
}

/**
 * Inserts a singular quest progress into the database.
 * 
 * @param playerId The ID of the player.
 * @param section The section that this quest progress belongs to.
 * @param data The data of this quest progress.
 */
export function insertPlayerQuestProgressSync(
    playerId: number,
    section: number | string,
    data: PlayerQuestProgress
) {
    getDb().prepare(`
    INSERT INTO players_quest_progress (section, quest_id, finished, unlocked, high_score, clear_rank, best_elapsed_time_ms, leader_character_id, host_finished, player_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        Number(section),
        data.questId,
        serializeBoolean(data.finished),
        serializeBoolean(data.unlocked ?? false),
        data.highScore ?? null,
        data.clearRank ?? null,
        data.bestElapsedTimeMs ?? null,
        data.leaderCharacterId ?? null,
        data.hostFinished === undefined ? null : serializeBoolean(data.hostFinished),
        playerId
    )
}

/**
 * Batch inserts a record of quest progress into the database.
 * 
 * @param playerId The player's ID.
 * @param progressList The record of quest progress.
 */
export function insertPlayerQuestProgressListSync(
    playerId: number,
    progressList: Record<string, PlayerQuestProgress[]>
) {
    getDb().transaction(() => {
        for (const [section, progresses] of Object.entries(progressList)) {
            for (const progress of progresses) {
                insertPlayerQuestProgressSync(playerId, section, progress)
            }
        }
    })()
}

/**
 * Updates the progress for a single player's quest.
 * 
 * @param playerId The ID of the player.
 * @param section The section that the quest belongs to.
 * @param data The partial data of the quest progress to update.
 */
export function updatePlayerQuestProgressSync(
    playerId: number,
    section: number | string,
    data: Partial<PlayerQuestProgress> & Pick<PlayerQuestProgress, 'questId'>
) {
    const fieldMap: Record<string, string> = {
        'finished': 'finished',
        'unlocked': 'unlocked',
        'highScore': 'high_score',
        'clearRank': 'clear_rank',
        'bestElapsedTimeMs': 'best_elapsed_time_ms',
        'leaderCharacterId': 'leader_character_id',
        'hostFinished': 'host_finished'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in data) {
        const value = data[key as keyof PlayerQuestProgress]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (typeof (value) === "boolean") {
                values.push(serializeBoolean(value))
            } else {
                values.push(value)
            }
        }
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players_quest_progress
        SET ${sets.join(', ')}
        WHERE section = ? AND quest_id = ? AND player_id = ?
        `).run([...values, Number(section), data.questId, playerId]);
}

export function incrementPlayerQuestMultiClearSync(
    playerId: number,
    section: number | string,
    questId: number | string,
): void {
    getDb().prepare(`
    UPDATE players_quest_progress
    SET multi_clear_count = multi_clear_count + 1
    WHERE player_id = ? AND section = ? AND quest_id = ?
    `).run(playerId, Number(section), Number(questId))
}

/**
 * Converts a RawPlayerGachaInfo object into a PlayerGachaInfo object.
 * 
 * @param rawInfo The raw object to convert.
 * @returns The converted object.
 */
/**
 * Gets a player's drawn quests list.
 * 
 * @param playerId The player's ID.
 * @returns A list of the player's drawn quests.
 */
export function getPlayerDrawnQuestsSync(
    playerId: number
): PlayerDrawnQuest[] {
    const rawQuests = getDb().prepare(`
    SELECT category_id, quest_id, odds_id
    FROM players_drawn_quests
    WHERE player_id = ?
    `).all(playerId) as RawPlayerDrawnQuest[]

    return rawQuests.map(raw => {
        return {
            categoryId: raw.category_id,
            questId: raw.quest_id,
            oddsId: raw.odds_id
        }
    })
}

/**
 * Inserts a singular drawn quest into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param drawnQuest The drawn quest to insert.
 */
function insertPlayerDrawnQuestSync(
    playerId: number,
    drawnQuest: PlayerDrawnQuest
) {
    getDb().prepare(`
    INSERT INTO players_drawn_quests (category_id, quest_id, odds_id, player_id)
    VALUES (?, ?, ?, ?)    
    `).run(
        drawnQuest.categoryId,
        drawnQuest.questId,
        drawnQuest.oddsId,
        playerId
    )
}

/**
 * Batch inserts a list of drawn quests into the database.
 * 
 * @param playerId The ID of the player.
 * @param drawnQuests The list of drawn quests to insert.
 */
export function insertPlayerDrawnQuestsSync(
    playerId: number,
    drawnQuests: PlayerDrawnQuest[]
) {
    getDb().transaction(() => {
        for (const drawnQuest of drawnQuests) {
            insertPlayerDrawnQuestSync(playerId, drawnQuest)
        }
    })()
}

/**
/**
/**
/**
 * Retrieves the missions that a player is currently completing.
 * 
 * @param playerId The ID of the player.
 * @returns A record of each mission and its current progress.
 */
