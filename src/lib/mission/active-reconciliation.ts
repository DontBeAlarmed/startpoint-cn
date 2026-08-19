import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getDb } from "../../data/db"
import {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} from "../../data/domains/mission"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerShopPurchasesMapSync } from "../../data/domains/shopPurchase"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getActiveMissionCountersSync } from "../../data/domains/active_mission_counters"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getPlayerCharacterClearsSync } from "../../data/domains/character_clear"
import { getActiveMissionConditionalBattleFactsSync } from "../../data/domains/active_mission_battle_condition_facts"
import { getActiveMissionBattleFactsSync } from "../../data/domains/active_mission_battle_facts"
import { ShopType } from "../types"
import {
    type ActiveMissionProgressDelta,
    type ActiveMissionProgressState,
    isActiveMissionAvailable,
    settleActiveMissionProgress,
} from "./active-core"
import {
    evaluateActiveMissionFact,
    type ActiveMissionFactQuestProgress,
    type ActiveMissionFactState,
} from "./active-fact-evaluator"
import { getCharacterStoryQuestIds } from "./character-queries"
import { getCharacterManaNodesSync } from "../assets"
import { getActiveMissionPlan, type ActiveMissionPlan, type PlannedActiveMissionDefinition } from "./active-plan"

export {
    estimateActiveMissionCharacterLevel,
} from "./active-fact-evaluator"
export { computeActiveMissionFactProgress } from "./active-fact-legacy-adapter"
export type {
    ActiveMissionFactCharacter,
    ActiveMissionFactQuestProgress,
    ActiveMissionFactState,
} from "./active-fact-evaluator"
export {
    matchesRawActiveMissionQuestRange as matchesActiveMissionQuestRange,
    resolveRawActiveMissionQuestIds as resolveActiveMissionQuestIds,
} from "./active-quest-range"

const COME_BACK_EVENT_STRING_ID = "come_back_mission"

export interface ActiveMissionEventEligibilityContext {
    readonly playerId: number
    readonly eventId: number
    readonly eventStringId: string
    readonly eventKind: number
}

export interface ReconcileActiveMissionFactsInput {
    readonly playerId: number
    readonly repository: ReadonlyContentRepository
    readonly now: number | Date
    readonly isEventEligible?: (context: ActiveMissionEventEligibilityContext) => boolean
}

function buildActiveMissionFactState(
    playerId: number,
    player: NonNullable<ReturnType<typeof getPlayerSync>>,
    finishedQuestIds: ReadonlySet<number>,
    questProgress: readonly ActiveMissionFactQuestProgress[],
    repository: ReadonlyContentRepository,
): ActiveMissionFactState {
    const characterList = getPlayerCharactersSync(playerId)
    const mainQuestTable = readRepositoryTable<Record<string, unknown>>(repository, "main_quest.json")
    const exQuestTable = readRepositoryTable<Record<string, unknown>>(repository, "ex_quest.json")
    const battleQuestIds = (table: Readonly<Record<string, unknown>>, offset: number): number[] => (
        Object.entries(table).flatMap(([questId, quest]) => {
            const parsedQuestId = Number(questId)
            if (!Number.isSafeInteger(parsedQuestId)
                || quest === null
                || typeof quest !== "object"
                || !("rankPointReward" in quest)) return []
            return [parsedQuestId + offset]
        })
    )
    const characterTable = readRepositoryTable<Record<string, { readonly rarity?: number }>>(
        repository,
        "character.json",
    )
    const characters = Object.fromEntries(Object.entries(characterList).map(([characterId, character]) => [
        characterId,
        {
            ...character,
            rarity: characterTable[characterId]?.rarity,
        },
    ]))
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const manaBoardNodes: Record<string, Record<string, number[]>> = {}
    const manaNodeSlots: Record<string, Record<string, number>> = {}
    for (const characterId of Object.keys(characters)) {
        const boards: Record<string, number[]> = {}
        const slots: Record<string, number> = {}
        for (let level = 1; level <= 2; level++) {
            const board = getCharacterManaNodesSync(characterId, level)
            if (!board) continue
            boards[String(level)] = Object.keys(board).map(Number)
            for (const [nodeId, node] of Object.entries(board)) {
                const slot = node.field6 === "1" ? 1 : node.field6 === "2" ? 2 : node.field6 === "3" ? 3 : 4
                slots[nodeId] = slot
            }
        }
        manaBoardNodes[characterId] = boards
        manaNodeSlots[characterId] = slots
    }
    const equipment = Object.entries(getPlayerEquipmentListSync(playerId)).map(([equipmentId, item]) => ({
        level: item.level,
        enhancementLevel: item.enhancementLevel,
        maxLevel: (() => {
            const row = readRepositoryTable<Record<string, { readonly max_level?: number }>>(
                repository,
                "equipment_dissolve.json",
            )[equipmentId]
            return row?.max_level ?? 5
        })(),
    }))
    const treasurePurchases = getPlayerShopPurchasesMapSync(playerId, ShopType.TREASURE)
    const bossCoinPurchases = getPlayerShopPurchasesMapSync(playerId, ShopType.BOSS_COIN)
    const counters = getActiveMissionCountersSync(playerId)
    const characterClears = getPlayerCharacterClearsSync(playerId)
    const battleCounters = getMissionBattleCountersSync(playerId)
    const treasureShopItemIds = new Set(Object.keys(readRepositoryTable<Record<string, unknown>>(
        repository,
        "treasure_shop.json",
    )))
    const bossCoinShopItemIds = new Set(Object.keys(readRepositoryTable<Record<string, unknown>>(
        repository,
        "boss_coin_shop_item_category_map.json",
    )))
    const bossCoinShopItems = readRepositoryTable<Record<string, Record<string, {
        readonly rewards?: readonly { readonly type?: number }[]
    }>>>(repository, "boss_coin_shop.json")
    const bossCoinEquipmentShopItemIds = new Set<string>()
    for (const category of Object.values(bossCoinShopItems)) {
        for (const [itemId, item] of Object.entries(category ?? {})) {
            if (item.rewards?.some(reward => reward.type === 4)) {
                bossCoinEquipmentShopItemIds.add(itemId)
            }
        }
    }
    const partyAbilitySoulCount = Object.values(getPlayerPartyGroupListSync(playerId)).reduce((total, group) => (
        total + Object.values(group.list ?? {}).reduce((partyTotal, party) => (
            partyTotal + (party.abilitySoulIds ?? []).filter(id => id !== null && id !== undefined).length
        ), 0)
    ), 0)
    return {
        player,
        battleCounters,
        finishedQuestIds,
        questProgress,
        chapterQuestIds: {
            "1": battleQuestIds(mainQuestTable, 0),
            "4": battleQuestIds(exQuestTable, 10_000_000),
        },
        practiceQuestChallengeCount: counters.practiceQuestChallengeCount,
        leaderClearCounts: Object.fromEntries(Object.keys(characters).map(characterId => {
            const clears = characterClears[characterId]
            return [characterId, {
                all: Math.max(0, clears?.leader_clear_count ?? 0),
                multi: Math.max(0, clears?.leader_multi_count ?? 0),
            }]
        })),
        conditionalBattleFacts: getActiveMissionConditionalBattleFactsSync(playerId),
        loadoutBattleFacts: getActiveMissionBattleFactsSync(playerId),
        characterStoryQuestIds: Object.fromEntries(Object.keys(characters).map(characterId => [
            characterId,
            getCharacterStoryQuestIds(characterId),
        ])),
        characters,
        equipment,
        manaNodes,
        manaBoardNodes,
        manaNodeSlots,
        partyAbilitySoulCount,
        treasureShopPurchaseCount: Object.entries(treasurePurchases).reduce((total, [itemId, count]) => (
            treasureShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        bossCoinShopPurchaseCount: Object.entries(bossCoinPurchases).reduce((total, [itemId, count]) => (
            bossCoinShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        bossCoinEquipmentShopPurchaseCount: Object.entries(bossCoinPurchases).reduce((total, [itemId, count]) => (
            bossCoinEquipmentShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        totalUsedManaCount: counters.totalUsedManaCount,
        totalGachaCharacterCount: counters.totalGachaCharacterCount,
        totalEquipmentEquipCount: counters.totalEquipmentEquipCount,
        totalUnisonSetCount: counters.totalUnisonSetCount,
        totalPartyCharacterSetCount: counters.totalPartyCharacterSetCount,
        totalInjectedExpCount: counters.totalInjectedExpCount,
        totalGachaCampaignCount: counters.totalGachaCampaignCount,
    }
}

function readRepositoryTable<T>(
    repository: ReadonlyContentRepository,
    tableName: string,
): T {
    try {
        return repository.table<T>(tableName)
    } catch {
        return {} as T
    }
}

function normalizeActiveMissions(
    activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>,
): Record<string, ActiveMissionProgressState> {
    return Object.fromEntries(Object.entries(activeMissions).map(([missionId, mission]) => [
        missionId,
        {
            progress: mission.progress,
            stages: mission.stages && !Array.isArray(mission.stages) ? mission.stages : {},
        },
    ]))
}

function isEligibleEvent(
    input: ReconcileActiveMissionFactsInput,
    plan: ActiveMissionPlan,
    definition: PlannedActiveMissionDefinition,
): boolean {
    const event = plan.getEvent(definition.mission.eventId)
    if (!event || typeof event.stringId !== "string") return false
    if (!event.stringId.includes(COME_BACK_EVENT_STRING_ID)) return true
    return input.isEventEligible?.({
        playerId: input.playerId,
        eventId: event.eventId,
        eventStringId: event.stringId,
        eventKind: event.kind,
    }) === true
}

function mergeDelta(
    deltas: Map<number, { progress: number, stages: Set<number> }>,
    delta: ActiveMissionProgressDelta,
): void {
    const current = deltas.get(delta.mission_id) ?? {
        progress: delta.progress_value,
        stages: new Set<number>(),
    }
    current.progress = delta.progress_value
    for (const stage of delta.stages) current.stages.add(stage.stage)
    deltas.set(delta.mission_id, current)
}

export function reconcileActiveMissionFacts(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionProgressDelta[] {
    return getDb().transaction(() => {
        const player = getPlayerSync(input.playerId)
        if (!player) throw new Error(`Player ${input.playerId} does not exist.`)

        const questProgress = getPlayerQuestProgressSync(input.playerId)
        const questProgressFacts = Object.entries(questProgress).flatMap(([category, progressList]) => (
            progressList.map(progress => ({
                category: Number(category),
                questId: progress.questId,
                finished: progress.finished,
                clearRank: progress.clearRank,
                leaderCharacterId: progress.leaderCharacterId,
                multiClearCount: Math.max(0, progress.multiClearCount ?? 0),
            }))
        ))
        const finishedQuestIds = new Set(Object.values(questProgress).flatMap(progressList => (
            progressList.filter(progress => progress.finished).map(progress => progress.questId)
        )))
        const activeMissions = normalizeActiveMissions(getPlayerActiveMissionsSync(input.playerId))
        const factState = buildActiveMissionFactState(
            input.playerId,
            player,
            finishedQuestIds,
            questProgressFacts,
            input.repository,
        )
        const plan = getActiveMissionPlan(input.repository)
        const definitions = plan.definitions
        const deltas = new Map<number, { progress: number, stages: Set<number> }>()

        // 事实只会单调增加；固定点确保同一次 /load 内 phase 与目标任务依赖可继续推进。
        for (let pass = 0; pass <= definitions.length; pass++) {
            let changed = false
            for (const definition of definitions) {
                let authoritativeProgress: number | null
                try {
                    if (!isEligibleEvent(input, plan, definition)) continue
                    if (!isActiveMissionAvailable(definition.missionId, {
                        repository: input.repository,
                        plan,
                        now: input.now,
                        activeMissions,
                        questProgress,
                    })) continue
                    authoritativeProgress = evaluateActiveMissionFact(
                        definition,
                        factState,
                        activeMissions,
                    )
                } catch {
                    continue
                }
                if (authoritativeProgress === null) continue
                if (activeMissions[String(definition.missionId)] === undefined
                    && authoritativeProgress <= 0) continue

                const settlement = settleActiveMissionProgress(
                    definition.missionId,
                    activeMissions[String(definition.missionId)],
                    authoritativeProgress,
                    { repository: input.repository, plan },
                )
                if (settlement.delta === null) continue

                updatePlayerActiveMissionSync(
                    input.playerId,
                    definition.missionId,
                    settlement.state.progress,
                )
                for (const stage of settlement.delta.stages) {
                    updatePlayerActiveMissionStageSync(
                        input.playerId,
                        stage.stage,
                        definition.missionId,
                        false,
                    )
                }
                activeMissions[String(definition.missionId)] = settlement.state
                mergeDelta(deltas, settlement.delta)
                changed = true
            }
            if (!changed) break
            if (pass === definitions.length) {
                throw new Error("Active Mission reconciliation did not converge.")
            }
        }

        return [...deltas.entries()]
            .sort(([left], [right]) => left - right)
            .map(([missionId, delta]) => ({
                mission_id: missionId,
                progress_value: delta.progress,
                stages: [...delta.stages]
                    .sort((left, right) => left - right)
                    .map(stage => ({ stage, received: false as const })),
            }))
    })()
}
