/**
 * Content-backed open-period boundary shared by the quest start routes and
 * the rush/raid finish projections.
 *
 * The CN 1.8.1 client handles result_code 4050 (QuestOutOfPeriod) gracefully
 * on every start remote (QuestStart/EventRushBattleStart/EventRaidBattleStart
 * → OutOfPeriodError), and the rush/raid finish response's is_out_of_period
 * tells the client whether the clear still counts toward quest progress.
 * Quests without a window boundary stay open, matching the multiplayer
 * availability checker's window semantics.
 */
export const QUEST_OUT_OF_PERIOD_RESULT_CODE = 4050

export function isQuestOutOfPeriodAt(
    quest: {
        readonly availableFromMs?: number | null
        readonly availableUntilMs?: number | null
    },
    atMs: number,
): boolean {
    const from = quest.availableFromMs ?? null
    const until = quest.availableUntilMs ?? null
    if (from !== null && atMs < from) return true
    if (until !== null && atMs > until) return true
    return false
}
