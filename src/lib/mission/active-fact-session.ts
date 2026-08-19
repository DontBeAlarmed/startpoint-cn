import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getActiveMissionCountersSync } from "../../data/domains/active_mission_counters"
import { getActiveMissionBattleFactsSync } from "../../data/domains/active_mission_battle_facts"
import { getActiveMissionConditionalBattleFactsSync } from "../../data/domains/active_mission_battle_condition_facts"
import { getPlayerCharacterClearsSync } from "../../data/domains/character_clear"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerActiveMissionsSync } from "../../data/domains/mission"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerShopPurchasesMapSync } from "../../data/domains/shopPurchase"
import { getCharacterManaNodesSync } from "../assets"
import { ShopType } from "../types"
import { getCharacterStoryQuestIds } from "./character-queries"
import type {
    ActiveMissionFactProgressState,
    ActiveMissionFactQuestProgress,
    ActiveMissionFactState,
} from "./active-fact-evaluator"
import type {
    ActiveMissionPlan,
} from "./active-plan"
import {
    ACTIVE_MISSION_FACT_KINDS,
    type ActiveMissionFactKind,
} from "./active-fact-kinds"

export { ACTIVE_MISSION_FACT_KINDS }

type ActiveMissionQuestProgressByCategory = ReturnType<typeof getPlayerQuestProgressSync>

export interface ActiveMissionFactObserver {
    definitionVisited?(missionId: number): void
    factLoaded?(kind: ActiveMissionFactKind, rows: number): void
    staticComputed?(missionId: number): void
    dependencyComputed?(missionId: number): void
}

export interface ActiveMissionFactLoadResult {
    readonly rows: number
    readonly facts?: Partial<ActiveMissionFactState>
    readonly activeMissions?: Record<string, ActiveMissionFactProgressState>
    readonly questProgressByCategory?: ActiveMissionQuestProgressByCategory
}

export type ActiveMissionFactDomainLoader = (
    playerId: number,
) => ActiveMissionFactLoadResult

export type ActiveMissionFactDomains = Readonly<Record<
    ActiveMissionFactKind,
    ActiveMissionFactDomainLoader
>>

export interface ActiveMissionFactSessionSnapshot {
    readonly facts: ActiveMissionFactState
    readonly activeMissions: Record<string, ActiveMissionFactProgressState>
    readonly questProgressByCategory: ActiveMissionQuestProgressByCategory
}

export interface ActiveMissionFactSession {
    loadKinds(kinds: readonly ActiveMissionFactKind[]): ActiveMissionFactSessionSnapshot
    loadFor(missionIds: readonly number[]): ActiveMissionFactSessionSnapshot
    /** @internal Reconciliation runner fast path. */
    ensureFor(missionIds: readonly number[]): void
    getLoadedKinds(): ReadonlySet<ActiveMissionFactKind>
    getInternalSnapshot(): ActiveMissionFactSessionSnapshot
    snapshot(): ActiveMissionFactSessionSnapshot
}

export interface CreateActiveMissionFactSessionOptions {
    readonly playerId: number
    readonly plan: ActiveMissionPlan
    readonly observer?: ActiveMissionFactObserver
    readonly domains?: ActiveMissionFactDomains
}

function emptyFactState(): ActiveMissionFactState {
    return {
        player: { totalLoginDays: 0, totalStaminaUsed: 0 },
        battleCounters: {
            singleClearCount: 0,
            multiClearCount: 0,
            multiHostClearCount: 0,
            singleRankSsCount: 0,
            rankSsCount: 0,
        },
        finishedQuestIds: new Set(),
        questProgress: [],
        chapterQuestIds: {},
        practiceQuestChallengeCount: 0,
        leaderClearCounts: {},
        conditionalBattleFacts: {},
        loadoutBattleFacts: {},
        characterStoryQuestIds: {},
        characters: {},
        equipment: [],
        manaNodes: {},
        manaBoardNodes: {},
        manaNodeSlots: {},
        partyAbilitySoulCount: 0,
        treasureShopPurchaseCount: 0,
        bossCoinShopPurchaseCount: 0,
        bossCoinEquipmentShopPurchaseCount: 0,
        totalUsedManaCount: 0,
        totalGachaCharacterCount: 0,
        totalEquipmentEquipCount: 0,
        totalUnisonSetCount: 0,
        totalPartyCharacterSetCount: 0,
        totalInjectedExpCount: 0,
        totalGachaCampaignCount: 0,
    }
}

function normalizeActiveMissions(
    missions: ReturnType<typeof getPlayerActiveMissionsSync>,
): Record<string, ActiveMissionFactProgressState> {
    return Object.fromEntries(Object.entries(missions).map(([missionId, mission]) => [missionId, {
        progress: mission.progress,
        stages: mission.stages && !Array.isArray(mission.stages) ? mission.stages : {},
    }]))
}

function readTable<T>(repository: ReadonlyContentRepository, tableName: string): T {
    try {
        return repository.table<T>(tableName)
    } catch {
        return {} as T
    }
}

function battleQuestIds(table: Readonly<Record<string, unknown>>, offset: number): number[] {
    return Object.entries(table).flatMap(([questId, quest]) => {
        const parsedQuestId = Number(questId)
        if (!Number.isSafeInteger(parsedQuestId)
            || quest === null
            || typeof quest !== "object"
            || !("rankPointReward" in quest)) return []
        return [parsedQuestId + offset]
    })
}

export function createProductionActiveMissionFactDomains(
    repository: ReadonlyContentRepository,
    playerOverride?: NonNullable<ReturnType<typeof getPlayerSync>>,
): ActiveMissionFactDomains {
    return {
        player: playerId => {
            const player = playerOverride ?? getPlayerSync(playerId)
            if (!player) throw new Error(`Player ${playerId} does not exist.`)
            return { rows: 1, facts: { player } }
        },
        questProgress: playerId => {
            const byCategory = getPlayerQuestProgressSync(playerId)
            const progress: ActiveMissionFactQuestProgress[] = Object.entries(byCategory)
                .flatMap(([category, progressList]) => progressList.map(quest => ({
                    category: Number(category),
                    questId: quest.questId,
                    finished: quest.finished,
                    clearRank: quest.clearRank,
                    leaderCharacterId: quest.leaderCharacterId,
                    multiClearCount: Math.max(0, quest.multiClearCount ?? 0),
                })))
            return {
                rows: progress.length,
                questProgressByCategory: byCategory,
                facts: {
                    questProgress: progress,
                    finishedQuestIds: new Set(progress.filter(quest => quest.finished).map(quest => quest.questId)),
                    chapterQuestIds: {
                        "1": battleQuestIds(readTable(repository, "main_quest.json"), 0),
                        "4": battleQuestIds(readTable(repository, "ex_quest.json"), 10_000_000),
                    },
                },
            }
        },
        activeProgress: playerId => {
            const activeMissions = normalizeActiveMissions(getPlayerActiveMissionsSync(playerId))
            return { rows: Object.keys(activeMissions).length, activeMissions }
        },
        characters: playerId => {
            const characterList = getPlayerCharactersSync(playerId)
            const table = readTable<Record<string, { readonly rarity?: number }>>(repository, "character.json")
            const characters = Object.fromEntries(Object.entries(characterList).map(([id, character]) => [id, {
                ...character,
                rarity: table[id]?.rarity,
            }]))
            return {
                rows: Object.keys(characters).length,
                facts: {
                    characters,
                    characterStoryQuestIds: Object.fromEntries(Object.keys(characters).map(id => [
                        id,
                        getCharacterStoryQuestIds(id),
                    ])),
                },
            }
        },
        characterClear: playerId => {
            const clears = getPlayerCharacterClearsSync(playerId)
            return {
                rows: Object.keys(clears).length,
                facts: {
                    leaderClearCounts: Object.fromEntries(Object.entries(clears).map(([id, clear]) => [id, {
                        all: Math.max(0, clear.leader_clear_count ?? 0),
                        multi: Math.max(0, clear.leader_multi_count ?? 0),
                    }])),
                },
            }
        },
        manaNodes: playerId => {
            const manaNodes = getPlayerCharactersManaNodesSync(playerId)
            const manaBoardNodes: Record<string, Record<string, number[]>> = {}
            const manaNodeSlots: Record<string, Record<string, number>> = {}
            for (const characterId of Object.keys(manaNodes)) {
                const boards: Record<string, number[]> = {}
                const slots: Record<string, number> = {}
                for (let level = 1; level <= 2; level++) {
                    const board = getCharacterManaNodesSync(characterId, level)
                    if (!board) continue
                    boards[String(level)] = Object.keys(board).map(Number)
                    for (const [nodeId, node] of Object.entries(board)) {
                        slots[nodeId] = node.field6 === "1" ? 1 : node.field6 === "2" ? 2 : node.field6 === "3" ? 3 : 4
                    }
                }
                manaBoardNodes[characterId] = boards
                manaNodeSlots[characterId] = slots
            }
            return {
                rows: Object.values(manaNodes).reduce((total, nodes) => total + nodes.length, 0),
                facts: { manaNodes, manaBoardNodes, manaNodeSlots },
            }
        },
        equipment: playerId => {
            const list = getPlayerEquipmentListSync(playerId)
            const table = readTable<Record<string, { readonly max_level?: number }>>(repository, "equipment_dissolve.json")
            const equipment = Object.entries(list).map(([id, item]) => ({
                level: item.level,
                enhancementLevel: item.enhancementLevel,
                maxLevel: table[id]?.max_level ?? 5,
            }))
            return { rows: equipment.length, facts: { equipment } }
        },
        party: playerId => {
            const groups = getPlayerPartyGroupListSync(playerId)
            const count = Object.values(groups).reduce((total, group) => total
                + Object.values(group.list ?? {}).reduce((sum, party) => sum
                    + (party.abilitySoulIds ?? []).filter(id => id !== null && id !== undefined).length, 0), 0)
            return { rows: Object.keys(groups).length, facts: { partyAbilitySoulCount: count } }
        },
        shopPurchases: playerId => loadShopPurchaseFacts(playerId, repository),
        counters: playerId => {
            const counters = getActiveMissionCountersSync(playerId)
            return {
                rows: 1,
                facts: {
                    practiceQuestChallengeCount: counters.practiceQuestChallengeCount,
                    totalUsedManaCount: counters.totalUsedManaCount,
                    totalGachaCharacterCount: counters.totalGachaCharacterCount,
                    totalEquipmentEquipCount: counters.totalEquipmentEquipCount,
                    totalUnisonSetCount: counters.totalUnisonSetCount,
                    totalPartyCharacterSetCount: counters.totalPartyCharacterSetCount,
                    totalInjectedExpCount: counters.totalInjectedExpCount,
                    totalGachaCampaignCount: counters.totalGachaCampaignCount,
                },
            }
        },
        battleCounters: playerId => ({ rows: 1, facts: { battleCounters: getMissionBattleCountersSync(playerId) } }),
        conditionalBattleFacts: playerId => {
            const facts = getActiveMissionConditionalBattleFactsSync(playerId)
            return { rows: Object.keys(facts).length, facts: { conditionalBattleFacts: facts } }
        },
        missionSpecificBattleFacts: playerId => {
            const facts = getActiveMissionBattleFactsSync(playerId)
            return { rows: Object.keys(facts).length, facts: { loadoutBattleFacts: facts } }
        },
    }
}

function loadShopPurchaseFacts(
    playerId: number,
    repository: ReadonlyContentRepository,
): ActiveMissionFactLoadResult {
    const treasure = getPlayerShopPurchasesMapSync(playerId, ShopType.TREASURE)
    const boss = getPlayerShopPurchasesMapSync(playerId, ShopType.BOSS_COIN)
    const treasureIds = new Set(Object.keys(readTable<Record<string, unknown>>(repository, "treasure_shop.json")))
    const bossIds = new Set(Object.keys(readTable<Record<string, unknown>>(repository, "boss_coin_shop_item_category_map.json")))
    const bossEquipmentIds = new Set<string>()
    const bossShop = readTable<Record<string, Record<string, { readonly rewards?: readonly { readonly type?: number }[] }>>>(repository, "boss_coin_shop.json")
    for (const category of Object.values(bossShop)) {
        for (const [itemId, item] of Object.entries(category ?? {})) {
            if (item.rewards?.some(reward => reward.type === 4)) bossEquipmentIds.add(itemId)
        }
    }
    const count = (entries: Record<string, number>, ids: ReadonlySet<string>) => Object.entries(entries)
        .reduce((total, [itemId, value]) => ids.has(itemId) ? total + Math.max(0, value) : total, 0)
    return {
        rows: Object.keys(treasure).length + Object.keys(boss).length,
        facts: {
            treasureShopPurchaseCount: count(treasure, treasureIds),
            bossCoinShopPurchaseCount: count(boss, bossIds),
            bossCoinEquipmentShopPurchaseCount: count(boss, bossEquipmentIds),
        },
    }
}

export function createActiveMissionFactSession(
    options: CreateActiveMissionFactSessionOptions,
): ActiveMissionFactSession {
    const facts = emptyFactState()
    const loaded = new Set<ActiveMissionFactKind>()
    const domains = options.domains
    if (!domains) throw new TypeError("Active Mission fact domains are required.")
    let activeMissions: Record<string, ActiveMissionFactProgressState> = {}
    let questProgressByCategory: ActiveMissionQuestProgressByCategory = {}
    const getInternalSnapshot = (): ActiveMissionFactSessionSnapshot => ({
        facts,
        activeMissions,
        questProgressByCategory,
    })
    const snapshot = (): ActiveMissionFactSessionSnapshot => structuredClone(getInternalSnapshot())
    const ensureKinds = (kinds: readonly ActiveMissionFactKind[]): void => {
        const needed = new Set(kinds)
        for (const kind of ACTIVE_MISSION_FACT_KINDS) {
            if (!needed.has(kind) || loaded.has(kind)) continue
            const factsBefore = { ...facts }
            const activeMissionsBefore = activeMissions
            const questProgressBefore = questProgressByCategory
            try {
                const result = domains[kind](options.playerId)
                if (result.facts) Object.assign(facts, result.facts)
                if (result.activeMissions) activeMissions = result.activeMissions
                if (result.questProgressByCategory) questProgressByCategory = result.questProgressByCategory
                options.observer?.factLoaded?.(kind, result.rows)
                loaded.add(kind)
            } catch (error) {
                const mutableFacts = facts as unknown as Record<string, unknown>
                for (const key of Object.keys(mutableFacts)) delete mutableFacts[key]
                Object.assign(facts, factsBefore)
                activeMissions = activeMissionsBefore
                questProgressByCategory = questProgressBefore
                throw error
            }
        }
    }
    const ensureFor = (missionIds: readonly number[]): void => {
        const needed = new Set<ActiveMissionFactKind>()
        for (const missionId of missionIds) {
            for (const kind of options.plan.getMission(missionId)?.factKinds ?? []) needed.add(kind)
        }
        ensureKinds([...needed])
    }
    const loadKinds = (kinds: readonly ActiveMissionFactKind[]): ActiveMissionFactSessionSnapshot => {
        ensureKinds(kinds)
        return snapshot()
    }
    return {
        ensureFor,
        loadKinds,
        loadFor(missionIds) {
            ensureFor(missionIds)
            return snapshot()
        },
        getLoadedKinds: () => new Set(loaded),
        getInternalSnapshot,
        snapshot,
    }
}
