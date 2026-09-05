export interface ExistingBattleQuestProgress {
    readonly bestElapsedTimeMs?: number | null
    readonly highScore?: number
    readonly clearRank?: number
}

export interface BattleQuestProgressPlanInput {
    readonly questAccomplished: boolean
    readonly questId: number
    readonly clearTime: number
    readonly score: number
    readonly clearRank: number | null
    readonly leaderCharacterId: number | null | undefined
    readonly missingLeader: "preserve" | "clear"
    readonly hostFinished?: boolean
    readonly existing: ExistingBattleQuestProgress | null
}

export interface BattleQuestProgressWriteValues {
    readonly questId: number
    readonly finished: true
    readonly bestElapsedTimeMs: number
    readonly highScore: number
    readonly clearRank?: number
    readonly leaderCharacterId?: number | null
    readonly hostFinished?: boolean
}

export type BattleQuestProgressPlan =
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "insert"; values: BattleQuestProgressWriteValues }>
    | Readonly<{ kind: "update"; values: BattleQuestProgressWriteValues }>

const NO_PROGRESS_WRITE: BattleQuestProgressPlan = Object.freeze({ kind: "none" })

function optionalIdentityValues(input: BattleQuestProgressPlanInput) {
    const leader = typeof input.leaderCharacterId === "number"
        ? { leaderCharacterId: input.leaderCharacterId }
        : input.missingLeader === "clear" ? { leaderCharacterId: null } : {}
    return {
        ...leader,
        ...(input.hostFinished === undefined ? {} : { hostFinished: input.hostFinished }),
    }
}

/** Plans the shared monotonic quest-history write without executing SQL. */
export function createBattleQuestProgressPlan(
    input: BattleQuestProgressPlanInput,
): BattleQuestProgressPlan {
    if (!input.questAccomplished) return NO_PROGRESS_WRITE

    if (input.existing === null) {
        return Object.freeze({
            kind: "insert" as const,
            values: Object.freeze({
                questId: input.questId,
                finished: true as const,
                bestElapsedTimeMs: input.clearTime,
                highScore: input.score,
                clearRank: input.clearRank ?? 5,
                ...optionalIdentityValues(input),
            }),
        })
    }

    return Object.freeze({
        kind: "update" as const,
        values: Object.freeze({
            questId: input.questId,
            finished: true as const,
            bestElapsedTimeMs: input.existing.bestElapsedTimeMs == null
                ? input.clearTime
                : Math.min(input.clearTime, input.existing.bestElapsedTimeMs),
            highScore: input.existing.highScore === undefined
                ? input.score
                : Math.max(input.score, input.existing.highScore),
            ...(input.clearRank === null ? {} : {
                clearRank: input.existing.clearRank === undefined
                    ? input.clearRank
                    : Math.max(input.clearRank, input.existing.clearRank),
            }),
            ...optionalIdentityValues(input),
        }),
    })
}
