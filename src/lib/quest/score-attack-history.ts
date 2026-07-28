import type { ScoreAttackBattleHistoryInsert } from "../../data/domains/score-attack-history"
import {
    buildBattleHistoryProtocolRecord,
    type BuildBattleHistoryInput,
} from "./battle-history"

export interface BuildScoreAttackBattleHistoryInput extends BuildBattleHistoryInput {
    readonly playerId: number
    readonly eventId: number
    readonly playId: string
}

export function buildScoreAttackBattleHistoryRecord(
    input: BuildScoreAttackBattleHistoryInput,
): ScoreAttackBattleHistoryInsert {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0
        || !Number.isSafeInteger(input.eventId) || input.eventId <= 0
        || typeof input.playId !== "string" || input.playId.length === 0) {
        throw new Error("Score attack history identity is invalid")
    }
    return {
        playerId: input.playerId,
        eventId: input.eventId,
        playId: input.playId,
        ...buildBattleHistoryProtocolRecord(input, 27, "Score attack history"),
    }
}
