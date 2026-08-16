import { getDb } from "../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    getPlayerActiveQuestSync,
    updatePlayerActiveQuestContinueCountSync,
} from "../../data/domains/quest_active"

export interface SingleContinueQuest {
    playId: string
    questId: number
    category: number
    isMulti: boolean
    continueCount: number
}

export interface SingleContinueLifecycleInput {
    playerId: number
    memoryQuest: SingleContinueQuest | undefined
    playId: string
    questId: number
    category: number
    cost: number
}

export interface SingleContinueLifecycleDependencies {
    transaction<T>(operation: () => T): T
    getPlayer(playerId: number): { freeVmoney: number, vmoney: number } | null
    getStoredActiveQuest(playerId: number): SingleContinueQuest | null
    updatePlayerCurrency(playerId: number, freeVmoney: number, vmoney: number): void
    updateStoredContinueCount(playerId: number, continueCount: number): void
}

export type SingleContinueLifecycleResult =
    | {
        ok: true
        freeVmoney: number
        vmoney: number
        continueCount: number
    }
    | { ok: false, message: string }

const defaultDependencies: SingleContinueLifecycleDependencies = {
    transaction: operation => getDb().transaction(operation)(),
    getPlayer: getPlayerSync,
    getStoredActiveQuest: getPlayerActiveQuestSync,
    updatePlayerCurrency: (playerId, freeVmoney, vmoney) => {
        updatePlayerSync({ id: playerId, freeVmoney, vmoney })
    },
    updateStoredContinueCount: updatePlayerActiveQuestContinueCountSync,
}

function matchesIdentity(
    quest: Pick<SingleContinueQuest, "playId" | "questId" | "category">,
    input: Pick<SingleContinueLifecycleInput, "playId" | "questId" | "category">,
): boolean {
    return quest.playId === input.playId
        && quest.questId === input.questId
        && quest.category === input.category
}

function isNonNegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0
}

export function runSingleContinueLifecycleTransaction(
    input: SingleContinueLifecycleInput,
    dependencies: SingleContinueLifecycleDependencies = defaultDependencies,
): SingleContinueLifecycleResult {
    if (!Number.isSafeInteger(input.cost) || input.cost <= 0) {
        return { ok: false, message: "Continue cost is invalid." }
    }
    if (!input.memoryQuest) {
        return { ok: false, message: "No active quest to continue." }
    }
    if (input.memoryQuest.isMulti) {
        return { ok: false, message: "Active quest is not a single battle." }
    }
    if (!matchesIdentity(input.memoryQuest, input)) {
        return { ok: false, message: "Active quest does not match continue request." }
    }

    const result = dependencies.transaction((): SingleContinueLifecycleResult => {
        const player = dependencies.getPlayer(input.playerId)
        const storedQuest = dependencies.getStoredActiveQuest(input.playerId)
        if (!player) return { ok: false, message: "Player not found." }
        if (!storedQuest) {
            return { ok: false, message: "No persisted active quest to continue." }
        }
        if (storedQuest.isMulti || !matchesIdentity(storedQuest, input)) {
            return {
                ok: false,
                message: "Persisted active quest does not match continue request.",
            }
        }
        if (!isNonNegativeSafeInteger(player.freeVmoney)
            || !isNonNegativeSafeInteger(player.vmoney)) {
            return { ok: false, message: "Player vmoney balance is invalid." }
        }
        if (!isNonNegativeSafeInteger(storedQuest.continueCount)
            || storedQuest.continueCount === Number.MAX_SAFE_INTEGER) {
            return { ok: false, message: "Persisted continue count is invalid." }
        }

        const freeSpent = Math.min(player.freeVmoney, input.cost)
        const paidCost = input.cost - freeSpent
        if (player.vmoney < paidCost) {
            return { ok: false, message: "Not enough vmoney to continue" }
        }

        const freeVmoney = player.freeVmoney - freeSpent
        const vmoney = player.vmoney - paidCost
        const continueCount = storedQuest.continueCount + 1
        dependencies.updatePlayerCurrency(input.playerId, freeVmoney, vmoney)
        dependencies.updateStoredContinueCount(input.playerId, continueCount)
        return { ok: true, freeVmoney, vmoney, continueCount }
    })

    if (result.ok) input.memoryQuest.continueCount = result.continueCount
    return result
}
