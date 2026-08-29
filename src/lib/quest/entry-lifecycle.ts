import { getRealNow } from "../../runtime/time/game-time"
import { assertDailyChallengePointAvailable } from "./daily-challenge"
import { STAMINA_OVERFLOW_MAX, computeRealTimeStamina } from "../stamina"
import type { StartEntryCost } from "./start-entry"
import { PlayerNotFoundError } from "./start-entry"

export interface EntryLifecycleActiveQuest {
    playId: string
    questId: number
    category: number
    entryItemId?: number | null
    entryItemCount?: number | null
    staminaCost?: number | null
    dailyChallengePointId?: number | null
}

export interface AbortEntryInput {
    playerId: number
    playId: string | null
    questId: number | null
    category: number | null
    now?: Date
}

export interface AbortEntryDependencies<TActiveQuest extends EntryLifecycleActiveQuest> {
    transaction<T>(operation: () => T): T
    getActiveQuest(playerId: number): TActiveQuest | null
    getPlayer(playerId: number): EntryLifecyclePlayer | null
    computeStamina(player: EntryLifecyclePlayer): number
    updatePlayer(update: Partial<EntryLifecyclePlayer> & Pick<EntryLifecyclePlayer, "id">): void
    getItemCount(playerId: number, itemId: number): number | null
    setItemCount(playerId: number, itemId: number, amount: number): void
    deleteActiveQuest(playerId: number): void
    clearActiveQuest(playerId: number): void
    getEntryCost(category: number, questId: number): StartEntryCost | undefined
}

export interface RestoreActiveQuestDependencies<TActiveQuest extends EntryLifecycleActiveQuest> {
    getEntryCost(category: number, questId: number): StartEntryCost | undefined
    persistEntryItemCount?(playerId: number, itemCount: number): void
    publishActiveQuest(playerId: number, activeQuest: TActiveQuest): void
}

export interface AbortEntryResult<TActiveQuest> {
    cancelled: boolean
    activeQuest: TActiveQuest | null
    observedActiveQuest: TActiveQuest | null
    resolvedIdentity: {
        playId: string
        questId: number
        category: number
    }
    itemList: Record<string, number>
    refundedStamina: number
}

export interface EntryLifecyclePlayer {
    id: number
    stamina: number
    staminaHealTime: Date
    totalStaminaUsed?: number | null
}

export interface CommitEntryResourcesInput<TActiveQuest extends EntryLifecycleActiveQuest> {
    playerId: number
    activeQuest: TActiveQuest
}

interface ChallengePointDomainEntry {
    id: number
    point: number
    campaignList: Array<{ campaignId: number; additionalPoint: number }>
}

export interface ChallengePointProjection {
    id: number
    point: number
    campaign_list: Array<{ campaign_id: number; additional_point: number }>
}

export interface CommitEntryResourcesDependencies {
    getPlayer(playerId: number): EntryLifecyclePlayer | null
    updatePlayer(update: Partial<EntryLifecyclePlayer> & Pick<EntryLifecyclePlayer, "id">): void
    refreshDailyChallengePoints(playerId: number): void
    getDailyChallengePointEntries(playerId: number): ChallengePointDomainEntry[]
    updateDailyChallengePoint(playerId: number, entryId: number, point: number): void
}

export interface CommitEntryResourcesResult {
    staminaUsed: number
    dailyChallengePointList: ChallengePointProjection[] | null
}

export interface ReleaseEntryResourcesInput<TActiveQuest extends EntryLifecycleActiveQuest> {
    playerId: number
    activeQuest: TActiveQuest
    now: Date
}

export interface ReleaseEntryResourcesDependencies {
    getPlayer(playerId: number): EntryLifecyclePlayer | null
    computeStamina(player: EntryLifecyclePlayer): number
    updatePlayer(update: Partial<EntryLifecyclePlayer> & Pick<EntryLifecyclePlayer, "id">): void
    getItemCount(playerId: number, itemId: number): number | null
    setItemCount(playerId: number, itemId: number, amount: number): void
    deleteActiveQuest(playerId: number): void
    getEntryCost?(
        category: number,
        questId: number,
    ): StartEntryCost | undefined
}

export interface ReleaseEntryResourcesResult {
    staminaUsed: 0
    refundedStamina: number
    itemList: Record<string, number>
    afterStamina: number
    afterStaminaHealTime: Date
}

interface PrepaidEntryItem {
    itemId: number
    itemCount: number
}

function assertNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < 0) throw new TypeError(`Invalid ${field}.`)
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
    assertNonNegativeSafeInteger(value, field)
    if (value <= 0) throw new TypeError(`Invalid ${field}.`)
}

function mapChallengePoint(entry: ChallengePointDomainEntry): ChallengePointProjection {
    return {
        id: entry.id,
        point: entry.point,
        campaign_list: entry.campaignList.map(campaign => ({
            campaign_id: campaign.campaignId,
            additional_point: campaign.additionalPoint,
        })),
    }
}

export function computeEntryLifecycleStamina(player: EntryLifecyclePlayer): number {
    const rankPoint = "rankPoint" in player && typeof player.rankPoint === "number"
        ? player.rankPoint : 0
    return computeRealTimeStamina({
        ...player,
        rankPoint,
    })
}

function resolvePrepaidEntryItem(
    activeQuest: EntryLifecycleActiveQuest,
    getEntryCost: (category: number, questId: number) => StartEntryCost | undefined,
): PrepaidEntryItem | null {
    const itemId = activeQuest.entryItemId
    if (itemId === null || itemId === undefined || itemId <= 0) return null

    const storedCount = activeQuest.entryItemCount
    if (storedCount !== null && storedCount !== undefined) {
        return storedCount > 0 ? { itemId, itemCount: storedCount } : null
    }

    const currentCost = getEntryCost(activeQuest.category, activeQuest.questId)
    if (!currentCost || currentCost.itemId !== itemId || currentCost.itemCount !== 1) return null
    return { itemId, itemCount: currentCost.itemCount }
}

export function runAbortEntryTransaction<TActiveQuest extends EntryLifecycleActiveQuest>(
    input: AbortEntryInput,
    dependencies: AbortEntryDependencies<TActiveQuest>,
): AbortEntryResult<TActiveQuest> {
    const result = dependencies.transaction(() => {
        const activeQuest = dependencies.getActiveQuest(input.playerId)
        const resolvedIdentity = {
            playId: input.playId ?? activeQuest?.playId ?? "",
            questId: input.questId ?? activeQuest?.questId ?? 0,
            category: input.category ?? activeQuest?.category ?? 0,
        }
        const matchesActiveQuest = activeQuest
            && activeQuest.playId === resolvedIdentity.playId
            && activeQuest.questId === resolvedIdentity.questId
            && activeQuest.category === resolvedIdentity.category
        if (!activeQuest || !matchesActiveQuest) {
            return {
                cancelled: false,
                activeQuest: null,
                observedActiveQuest: activeQuest,
                resolvedIdentity,
                itemList: {},
                refundedStamina: 0,
            }
        }

        const released = releaseEntryResources({
            playerId: input.playerId,
            activeQuest,
            now: input.now ?? getRealNow(),
        }, {
            ...dependencies,
            getPlayer: dependencies.getPlayer ?? (() => null),
        })
        return {
            cancelled: true,
            activeQuest,
            observedActiveQuest: activeQuest,
            resolvedIdentity,
            itemList: released.itemList,
            refundedStamina: released.refundedStamina,
        }
    })

    if (result.cancelled || result.observedActiveQuest === null) {
        dependencies.clearActiveQuest(input.playerId)
    }
    return result
}

export function restoreActiveQuestFromStorage<TActiveQuest extends EntryLifecycleActiveQuest>(
    playerId: number,
    activeQuest: TActiveQuest,
    dependencies: RestoreActiveQuestDependencies<TActiveQuest>,
): TActiveQuest {
    const prepaidItem = resolvePrepaidEntryItem(activeQuest, dependencies.getEntryCost)
    const restoredQuest = prepaidItem && activeQuest.entryItemCount !== prepaidItem.itemCount
        ? { ...activeQuest, entryItemCount: prepaidItem.itemCount }
        : activeQuest
    if (prepaidItem && activeQuest.entryItemCount !== prepaidItem.itemCount) {
        dependencies.persistEntryItemCount?.(playerId, prepaidItem.itemCount)
    }
    dependencies.publishActiveQuest(playerId, restoredQuest)
    return restoredQuest
}

export function commitEntryResources<TActiveQuest extends EntryLifecycleActiveQuest>(
    input: CommitEntryResourcesInput<TActiveQuest>,
    dependencies: CommitEntryResourcesDependencies,
): CommitEntryResourcesResult {
    const { activeQuest, playerId } = input
    let staminaUsed = 0
    if (activeQuest.staminaCost !== null && activeQuest.staminaCost !== undefined) {
        assertNonNegativeSafeInteger(activeQuest.staminaCost, "stamina cost")
        if (activeQuest.staminaCost > 0) {
            const player = dependencies.getPlayer(playerId)
            if (!player) throw new PlayerNotFoundError(playerId)
            staminaUsed = activeQuest.staminaCost
            dependencies.updatePlayer({
                id: playerId,
                totalStaminaUsed: (player.totalStaminaUsed ?? 0) + staminaUsed,
            })
        }
    }

    const pointId = activeQuest.dailyChallengePointId
    let dailyChallengePointList: ChallengePointProjection[] | null = null
    if (pointId !== null && pointId !== undefined) {
        assertPositiveSafeInteger(pointId, "daily challenge point id")
        dependencies.refreshDailyChallengePoints(playerId)
        const entries = dependencies.getDailyChallengePointEntries(playerId)
        assertDailyChallengePointAvailable(pointId, entries)
        const entry = entries.find(candidate => candidate.id === pointId)
        if (entry) {
            dependencies.updateDailyChallengePoint(playerId, pointId, entry.point - 1)
            entry.point -= 1
        }
        dailyChallengePointList = entries.map(mapChallengePoint)
    }

    return { staminaUsed, dailyChallengePointList }
}

export function releaseEntryResources<TActiveQuest extends EntryLifecycleActiveQuest>(
    input: ReleaseEntryResourcesInput<TActiveQuest>,
    dependencies: ReleaseEntryResourcesDependencies,
): ReleaseEntryResourcesResult {
    const { activeQuest, playerId } = input
    const player = dependencies.getPlayer(playerId)
    const currentStamina = player ? dependencies.computeStamina(player) : 0
    const afterStaminaHealTime = input.now
    let refundedStamina = 0
    let afterStamina = currentStamina
    const itemList: Record<string, number> = {}
    if (activeQuest.staminaCost !== null && activeQuest.staminaCost !== undefined) {
        assertNonNegativeSafeInteger(activeQuest.staminaCost, "stamina cost")
        if (activeQuest.staminaCost > 0) {
            if (!player) throw new PlayerNotFoundError(playerId)
            refundedStamina = activeQuest.staminaCost
            afterStamina = Math.min(currentStamina + refundedStamina, STAMINA_OVERFLOW_MAX)
            dependencies.updatePlayer({
                id: playerId,
                stamina: afterStamina,
                staminaHealTime: afterStaminaHealTime,
            })
        }
    }

    const itemId = activeQuest.entryItemId
    if (itemId !== null && itemId !== undefined && itemId > 0
        && activeQuest.entryItemCount !== null && activeQuest.entryItemCount !== undefined) {
        assertNonNegativeSafeInteger(activeQuest.entryItemCount, "entry item count")
    }

    const prepaidItem = itemId !== null && itemId !== undefined && itemId > 0
        ? resolvePrepaidEntryItem(activeQuest, dependencies.getEntryCost ?? (() => undefined))
        : null
    if (prepaidItem) {
        const afterCount = (dependencies.getItemCount(playerId, prepaidItem.itemId) ?? 0)
            + prepaidItem.itemCount
        dependencies.setItemCount(playerId, prepaidItem.itemId, afterCount)
        itemList[prepaidItem.itemId] = afterCount
    }

    dependencies.deleteActiveQuest(playerId)
    return {
        staminaUsed: 0,
        refundedStamina,
        itemList,
        afterStamina,
        afterStaminaHealTime,
    }
}
