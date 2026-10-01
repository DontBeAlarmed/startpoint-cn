import { getPlayerQuestClearCountsSync } from "../../data/domains/quest"
import type { TranslatedMissionQuestRange } from "./quest-range-translator"

/**
 * Recomputable per-quest clear-count facts over the quest archive
 * (players_quest_progress), the official returning-mission precedent:
 * progress floors are re-derived from persisted quest facts instead of
 * starting at zero when a mission row appears.
 *
 * Battle-mode discrimination mirrors matchesBattleCountCondition: single
 * rows count single finishes, multi rows count multi finishes, any rows
 * count both. Windowed rows (daily/collect events) must NOT use this as a
 * blanket floor — the archive is all-time — so no evaluation path wires
 * this automatically; lifetime-shaped rows adopt it explicitly.
 */

export type ArchiveClearMode = "single" | "multi" | "any"

function clearCountOf(
    row: { readonly singleClearCount: number, readonly multiClearCount: number },
    mode: ArchiveClearMode,
): number {
    switch (mode) {
        case "single": return row.singleClearCount
        case "multi": return row.multiClearCount
        case "any": return row.singleClearCount + row.multiClearCount
    }
}

/**
 * Sums archived clears over a translated mission range. Unconstrained
 * ranges (no range kind) match every archived quest.
 */
export function sumArchiveQuestClearCountsSync(
    playerId: number,
    range: TranslatedMissionQuestRange,
    mode: ArchiveClearMode,
): number {
    const rows = getPlayerQuestClearCountsSync(
        playerId,
        range.unconstrained ? undefined : range.sections,
    )
    let total = 0
    for (const row of rows) {
        if (!range.matches(row.section, row.questId)) continue
        total += clearCountOf(row, mode)
        if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER
    }
    return total
}
