import type { Player, PlayerQuestProgress } from "../../data/types"
import { getDb } from "../../data/db"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerSingleQuestProgressSync } from "../../data/domains/quest"
import { getPlayerActiveQuestSync } from "../../data/domains/quest_active"
import type { ActiveQuest } from "./active-quest-service"

export interface SingleFinishRequestIdentity {
    playId: unknown
    questId: unknown
    category: unknown
    continueCount: unknown
}

export interface SingleFinishSettlementContext {
    activeQuest: ActiveQuest
    player: Player
    questProgress: PlayerQuestProgress | null
}

interface SingleFinishSettlementDependencies {
    transaction<T>(operation: () => T): T
    getStoredActiveQuest(playerId: number): ActiveQuest | null
    getPlayer(playerId: number): Player | null
    getQuestProgress(
        playerId: number,
        category: number,
        questId: number,
    ): PlayerQuestProgress | null
}

const defaultDependencies: SingleFinishSettlementDependencies = {
    transaction: operation => getDb().transaction(operation)(),
    getStoredActiveQuest: getPlayerActiveQuestSync,
    getPlayer: getPlayerSync,
    getQuestProgress: getPlayerSingleQuestProgressSync,
}

export class SingleFinishSettlementValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SingleFinishSettlementValidationError"
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function matchesRequestIdentity(
    quest: ActiveQuest,
    request: SingleFinishRequestIdentity,
): boolean {
    return quest.playId === request.playId
        && quest.questId === request.questId
        && quest.category === request.category
        && quest.continueCount === request.continueCount
}

function validateRequestIdentity(request: SingleFinishRequestIdentity): void {
    if (typeof request.playId !== "string"
        || request.playId.length === 0
        || !isPositiveSafeInteger(request.questId)
        || !isPositiveSafeInteger(request.category)
        || !isNonNegativeSafeInteger(request.continueCount)) {
        throw new SingleFinishSettlementValidationError("Invalid settlement identity.")
    }
}

function validateSettlementState(
    memoryQuest: ActiveQuest,
    storedQuest: ActiveQuest | null,
    request: SingleFinishRequestIdentity,
    player: Pick<Player, "boostPoint" | "bossBoostPoint">,
): asserts storedQuest is ActiveQuest {
    validateRequestIdentity(request)
    if (!storedQuest
        || memoryQuest.isMulti
        || storedQuest.isMulti
        || !matchesRequestIdentity(memoryQuest, request)
        || !matchesRequestIdentity(storedQuest, request)) {
        throw new SingleFinishSettlementValidationError(
            "Active quest does not match finish request.",
        )
    }
    if (memoryQuest.useBoostPoint !== storedQuest.useBoostPoint
        || memoryQuest.useBossBoostPoint !== storedQuest.useBossBoostPoint) {
        throw new SingleFinishSettlementValidationError(
            "Active quest Boost state does not match settlement.",
        )
    }
    if (storedQuest.useBoostPoint && storedQuest.useBossBoostPoint) {
        throw new SingleFinishSettlementValidationError("Invalid Boost state.")
    }
    if (!isNonNegativeSafeInteger(player.boostPoint)
        || !isNonNegativeSafeInteger(player.bossBoostPoint)) {
        throw new SingleFinishSettlementValidationError("Invalid Boost balance.")
    }
    if ((storedQuest.useBoostPoint && player.boostPoint < 1)
        || (storedQuest.useBossBoostPoint && player.bossBoostPoint < 1)) {
        throw new SingleFinishSettlementValidationError("Not enough boost points.")
    }
}

export function runSingleFinishSettlementTransaction<T>({
    playerId,
    memoryQuest,
    request,
    settle,
    dependencies = defaultDependencies,
}: {
    playerId: number
    memoryQuest: ActiveQuest
    request: SingleFinishRequestIdentity
    settle(context: SingleFinishSettlementContext): T
    dependencies?: SingleFinishSettlementDependencies
}): T {
    return dependencies.transaction(() => {
        const storedQuest = dependencies.getStoredActiveQuest(playerId)
        const player = dependencies.getPlayer(playerId)
        if (!player) {
            throw new SingleFinishSettlementValidationError("Invalid viewer id.")
        }
        validateSettlementState(memoryQuest, storedQuest, request, player)
        const questProgress = dependencies.getQuestProgress(
            playerId,
            storedQuest.category,
            storedQuest.questId,
        )
        return settle({ activeQuest: storedQuest, player, questProgress })
    })
}
