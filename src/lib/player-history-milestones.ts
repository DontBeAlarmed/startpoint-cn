import bundledMainQuests from "../../assets/main_quest.json"

import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import { getDb } from "../data/db"
import { recordPlayerHistoryMilestoneSync } from "../data/domains/player-history-facts"
import { getRealNow } from "../runtime/time/game-time"
import { getRankDegree } from "./stamina"

type MainQuestTable = Record<string, unknown>

export function recordHundredCharactersMilestoneSync(
    playerId: number,
    occurredAt: Date = getRealNow(),
): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    if (!Number.isFinite(occurredAt.getTime())) {
        throw new TypeError("occurredAt must be a valid Date")
    }
    // Keep the threshold check in the write statement so character grants do
    // not add a separate SELECT to the reward hot path.
    return getDb().prepare(`
        INSERT OR IGNORE INTO players_player_history_milestones (
            player_id, aggregation_target, slot, occurred_at, subject_id
        )
        SELECT ?, 7, 0, ?, NULL
        WHERE (SELECT COUNT(*) FROM players_characters WHERE player_id = ?) >= 100
    `).run(playerId, occurredAt.toISOString(), playerId).changes > 0
}

export function recordRank100MilestoneSync(
    playerId: number,
    rankPoint: number,
    occurredAt: Date = getRealNow(),
): boolean {
    return getRankDegree(rankPoint) >= 100 && recordPlayerHistoryMilestoneSync(playerId, {
        aggregationTarget: 8,
        slot: 0,
        occurredAt,
    })
}

export function recordSecondManaBoardCompletionMilestoneSync(
    playerId: number,
    characterId: number,
    occurredAt: Date = getRealNow(),
): boolean {
    return recordPlayerHistoryMilestoneSync(playerId, {
        aggregationTarget: 4,
        slot: 0,
        subjectId: characterId,
        occurredAt,
    })
}

export function recordCompletedMainChapterMilestoneSync(
    playerId: number,
    questId: number,
    occurredAt: Date = getRealNow(),
): boolean {
    const chapter = Math.floor(questId / 1_000_000)
    if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 12) return false
    const mainQuests = getRuntimeContentTableSync(
        "main_quest.json",
        bundledMainQuests as MainQuestTable,
    ) as MainQuestTable
    const chapterQuestIds = Object.keys(mainQuests).map(Number).filter(id => (
        Math.floor(id / 1_000_000) === chapter
    ))
    if (chapterQuestIds.length === 0) return false
    // Main progression is linear, so only the chapter's final quest can
    // complete the chapter. Avoid a full chapter count after every stage.
    if (questId !== Math.max(...chapterQuestIds)) return false
    const placeholders = chapterQuestIds.map(() => "?").join(", ")
    const row = getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM players_quest_progress
        WHERE player_id = ? AND section = 1 AND finished = 1
          AND quest_id IN (${placeholders})
    `).get(playerId, ...chapterQuestIds) as { count: number }
    if (row.count !== chapterQuestIds.length) return false
    return recordPlayerHistoryMilestoneSync(playerId, {
        aggregationTarget: chapter <= 6 ? 2 : 3,
        slot: chapter <= 6 ? chapter - 1 : chapter - 7,
        occurredAt,
    })
}
