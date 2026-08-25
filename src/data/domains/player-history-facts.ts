import { getDb } from "../db"

export interface PlayerHistoryMilestoneInput {
    readonly aggregationTarget: 2 | 3 | 4 | 7 | 8 | 26
    readonly slot: number
    readonly occurredAt: Date
    readonly subjectId?: number
}

export interface PlayerHistoryMilestone extends PlayerHistoryMilestoneInput {}

const SLOT_LIMITS: Readonly<Record<PlayerHistoryMilestoneInput["aggregationTarget"], number>> = Object.freeze({
    2: 6,
    3: 6,
    4: 1,
    7: 1,
    8: 1,
    26: 1,
})

function validateMilestone(input: PlayerHistoryMilestoneInput): void {
    const limit = SLOT_LIMITS[input.aggregationTarget]
    if (limit === undefined || !Number.isSafeInteger(input.slot) || input.slot < 0 || input.slot >= limit) {
        throw new TypeError("player history milestone slot is invalid")
    }
    if (!Number.isFinite(input.occurredAt.getTime())) {
        throw new TypeError("player history milestone occurredAt must be a valid Date")
    }
    if (input.subjectId !== undefined
        && (!Number.isSafeInteger(input.subjectId) || input.subjectId <= 0)) {
        throw new TypeError("player history milestone subjectId must be a positive safe integer")
    }
}

/** Records the first authoritative occurrence for one history milestone slot. */
export function recordPlayerHistoryMilestoneSync(
    playerId: number,
    input: PlayerHistoryMilestoneInput,
): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    validateMilestone(input)
    return getDb().prepare(`
        INSERT OR IGNORE INTO players_player_history_milestones (
            player_id, aggregation_target, slot, occurred_at, subject_id
        ) VALUES (?, ?, ?, ?, ?)
    `).run(
        playerId,
        input.aggregationTarget,
        input.slot,
        input.occurredAt.toISOString(),
        input.subjectId ?? null,
    ).changes > 0
}

export function getPlayerHistoryMilestonesSync(playerId: number): readonly PlayerHistoryMilestone[] {
    const rows = getDb().prepare(`
        SELECT aggregation_target, slot, occurred_at, subject_id
        FROM players_player_history_milestones
        WHERE player_id = ?
        ORDER BY aggregation_target, slot
    `).all(playerId) as Array<{
        aggregation_target: PlayerHistoryMilestoneInput["aggregationTarget"]
        slot: number
        occurred_at: string
        subject_id: number | null
    }>
    return rows.map(row => Object.freeze({
        aggregationTarget: row.aggregation_target,
        slot: row.slot,
        occurredAt: new Date(row.occurred_at),
        ...(row.subject_id === null ? {} : { subjectId: row.subject_id }),
    }))
}
