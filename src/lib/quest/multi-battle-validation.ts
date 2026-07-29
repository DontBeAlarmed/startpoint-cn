import type { ActiveQuest } from "./active-quest-service"

export interface MultiStartValidationInput {
    viewerId: number
    partyId: number
    questId: number
    category: number
    playId: string
    useBoostPoint: unknown
    useBossBoostPoint: unknown
    isAutoStartMode: unknown
    isRoomMember: boolean
    roomCategory: number
    roomQuestId: number
}

export type MultiStartValidationResult =
    | { ok: true }
    | { ok: false, message: string }

export interface MultiFinishBalances {
    boostPoint: number
    bossBoostPoint: number
}

export interface ValidatedMultiFinish {
    ok: true
    elapsedTimeMs: number
    addMana: number
    score: number
    statistics: Record<string, unknown>
}

export type MultiFinishValidationResult =
    | ValidatedMultiFinish
    | { ok: false, message: string }

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

export function validateMultiStartRequest(
    input: MultiStartValidationInput,
): MultiStartValidationResult {
    if (!isPositiveSafeInteger(input.viewerId)
        || !isPositiveSafeInteger(input.partyId)
        || !isPositiveSafeInteger(input.questId)
        || !isPositiveSafeInteger(input.category)
        || typeof input.playId !== "string"
        || input.playId.length === 0
        || typeof input.useBoostPoint !== "boolean"
        || typeof input.useBossBoostPoint !== "boolean"
        || typeof input.isAutoStartMode !== "boolean") {
        return { ok: false, message: "Invalid request body." }
    }
    if (!input.isRoomMember) {
        return { ok: false, message: "Player is not a member of this room." }
    }
    if (input.roomCategory !== input.category || input.roomQuestId !== input.questId) {
        return { ok: false, message: "Room quest does not match start request." }
    }
    return { ok: true }
}

export function validateMultiFinishRequest(
    body: Record<string, unknown>,
    activeQuest: Pick<ActiveQuest,
        "playId" | "questId" | "category" | "isMulti" | "continueCount"
        | "useBoostPoint" | "useBossBoostPoint">,
    balances: MultiFinishBalances,
): MultiFinishValidationResult {
    if (!activeQuest.isMulti
        || body.play_id !== activeQuest.playId
        || body.quest_id !== activeQuest.questId
        || body.category !== activeQuest.category) {
        return { ok: false, message: "Active quest does not match finish request." }
    }

    const elapsedTimeMs = body.elapsed_time_ms
    const addMana = body.add_mana
    const score = body.score
    const continueCount = body.continue_count
    const statistics = body.statistics ?? body.quest_statistics
    if (!isPositiveSafeInteger(elapsedTimeMs)
        || !isNonNegativeSafeInteger(addMana)
        || typeof score !== "number"
        || !Number.isFinite(score)
        || score < 0
        || typeof body.is_accomplished !== "boolean"
        || !isNonNegativeSafeInteger(continueCount)
        || continueCount !== activeQuest.continueCount
        || statistics === null
        || typeof statistics !== "object"
        || Array.isArray(statistics)
        || Object.keys(statistics).length === 0) {
        return { ok: false, message: "Invalid finish result." }
    }
    if ((activeQuest.useBoostPoint && balances.boostPoint < 1)
        || (activeQuest.useBossBoostPoint && balances.bossBoostPoint < 1)) {
        return { ok: false, message: "Not enough boost points." }
    }

    return {
        ok: true,
        elapsedTimeMs,
        addMana,
        score,
        statistics: statistics as Record<string, unknown>,
    }
}
