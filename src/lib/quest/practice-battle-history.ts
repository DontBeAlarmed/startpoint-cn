import type { PracticeBattleHistoryInsert } from "../../data/domains/practice-battle-history"
import {
    buildBattleHistoryProtocolRecord,
    type BuildBattleHistoryInput,
} from "./battle-history"

export interface BuildPracticeBattleHistoryInput extends BuildBattleHistoryInput {
    readonly playerId: number
    readonly playId: string
}

export function buildPracticeBattleHistoryRecord(
    input: BuildPracticeBattleHistoryInput,
): PracticeBattleHistoryInsert {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0
        || typeof input.playId !== "string" || input.playId.length === 0) {
        throw new Error("Practice battle history identity is invalid")
    }
    return {
        playerId: input.playerId,
        playId: input.playId,
        ...buildBattleHistoryProtocolRecord(input, 15, "Practice battle history"),
    }
}
