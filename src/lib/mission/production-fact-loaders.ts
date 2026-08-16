import {
    getMissionBattleCountersSync,
    type MissionBattleCounters,
} from "../../data/domains/mission_battle_facts"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import {
    getPlayerCharactersManaNodesSync,
    getPlayerCharactersSync,
} from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import {
    getPlayerCollectedItemTotalsByIdsSync,
    getPlayerCollectedItemTotalsSync,
    getPlayerItemsSync,
} from "../../data/domains/item"
import { getPlayerCategoryMissionProgressByIdsSync } from "../../data/domains/mission"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import {
    getDegreeBattleStatsSync,
    type DegreeBattleStats,
} from "../../data/domains/degree_battle_stats"
import {
    getPlayerShopPurchasesMapSync,
    type ShopPurchaseMap,
} from "../../data/domains/shopPurchase"
import type {
    Player,
    PlayerActiveMission,
    PlayerCharacter,
    PlayerEquipment,
    PlayerPartyGroup,
    PlayerQuestProgress,
} from "../../data/types"
import { MissionFactLoaderRegistry } from "./fact-loaders"
import {
    getPassWeekSnapshotType,
    getSnapshot,
    type SnapshotData,
} from "./snapshot"
import {
    getPlayerPassCardStateSync,
    type PlayerPassCardState,
} from "../../data/domains/pass-card"

export interface ProductionMissionFactDomains {
    readonly getPlayerSync: (playerId: number) => Player | null
    readonly getPlayerCharactersSync: (playerId: number) => Record<string, PlayerCharacter>
    readonly getPlayerCharactersManaNodesSync: (playerId: number) => Record<string, number[]>
    readonly getPlayerEquipmentListSync: (playerId: number) => Record<string, PlayerEquipment>
    readonly getPlayerItemsSync: (playerId: number) => Record<string, number>
    readonly getPlayerPartyGroupListSync: (
        playerId: number,
        category: number,
    ) => Record<string, PlayerPartyGroup>
    readonly getPlayerCategoryMissionProgressByIdsSync: (
        playerId: number,
        category: number,
        missionIds: readonly number[],
    ) => ReadonlyMap<number, number>
    readonly getPlayerCollectedItemTotalsByIdsSync: (
        playerId: number,
        itemIds: readonly number[],
    ) => Record<string, number>
    readonly getPlayerCollectedItemTotalsSync: (playerId: number) => Record<string, number>
    readonly getDegreeBattleStatsSync: (playerId: number) => DegreeBattleStats
    readonly getPlayerQuestProgressSync: (
        playerId: number,
        sections?: readonly number[],
    ) => Record<string, PlayerQuestProgress[]>
    readonly getMissionBattleCountersSync: (playerId: number) => MissionBattleCounters
    readonly getPlayerShopPurchasesMapSync: (
        playerId: number,
        shopType: number,
    ) => ShopPurchaseMap
    readonly getSnapshot: (playerId: number, periodType: string) => SnapshotData | null
    readonly getPassWeekSnapshotType: (eventId: number) => string
    readonly getPlayerPassCardStateSync: (playerId: number, eventId: number) => PlayerPassCardState
}

export interface ProductionMissionFactSeeds {
    readonly player?: Player
    readonly categoryMissions?: ReadonlyMap<
        number,
        Readonly<Record<string, PlayerActiveMission>>
    >
}

const productionDomains: ProductionMissionFactDomains = {
    getPlayerSync,
    getPlayerCharactersSync,
    getPlayerCharactersManaNodesSync,
    getPlayerEquipmentListSync,
    getPlayerItemsSync,
    getPlayerPartyGroupListSync,
    getPlayerCategoryMissionProgressByIdsSync,
    getPlayerCollectedItemTotalsByIdsSync,
    getPlayerCollectedItemTotalsSync,
    getDegreeBattleStatsSync,
    getPlayerQuestProgressSync,
    getMissionBattleCountersSync,
    getPlayerShopPurchasesMapSync,
    getSnapshot,
    getPassWeekSnapshotType,
    getPlayerPassCardStateSync,
}

export function createProductionMissionFactLoaderRegistry(
    domains: ProductionMissionFactDomains = productionDomains,
    seeds: ProductionMissionFactSeeds = {},
): MissionFactLoaderRegistry {
    return new MissionFactLoaderRegistry()
        .register("player", ({ playerId }) => {
            const player = seeds.player ?? domains.getPlayerSync(playerId)
            if (player === null) throw new Error(`Mission evaluation player ${playerId} not found`)
            return player
        })
        .register("characters", ({ playerId }) => domains.getPlayerCharactersSync(playerId))
        .register("characterManaNodes", ({ playerId }) => (
            domains.getPlayerCharactersManaNodesSync(playerId)
        ))
        .register("equipment", ({ playerId }) => domains.getPlayerEquipmentListSync(playerId))
        .register("items", ({ playerId }) => domains.getPlayerItemsSync(playerId))
        .register("partyGroups", ({ playerId, key }) => (
            domains.getPlayerPartyGroupListSync(playerId, key.category)
        ))
        .register("categoryMissionProgress", ({ playerId, key }) => {
            const seeded = seeds.categoryMissions?.get(key.category)
            if (seeded === undefined) {
                return domains.getPlayerCategoryMissionProgressByIdsSync(
                    playerId,
                    key.category,
                    key.missionIds,
                )
            }
            return new Map(key.missionIds.flatMap(missionId => {
                const mission = seeded[String(missionId)]
                return mission === undefined ? [] : [[missionId, mission.progress] as const]
            }))
        })
        .register("collectedItems", ({ playerId, key }) => (
            key.itemIds === "all"
                ? domains.getPlayerCollectedItemTotalsSync(playerId)
                : domains.getPlayerCollectedItemTotalsByIdsSync(playerId, key.itemIds)
        ))
        .register("questProgress", ({ playerId, key }) => (
            domains.getPlayerQuestProgressSync(
                playerId,
                key.sections === "all" ? undefined : key.sections,
            )
        ))
        .register("missionBattleCounters", ({ playerId }) => (
            domains.getMissionBattleCountersSync(playerId)
        ))
        .register("shopPurchases", ({ playerId, key }) => (
            domains.getPlayerShopPurchasesMapSync(playerId, key.shopType)
        ))
        .register("degreeBattleStats", ({ playerId }) => (
            domains.getDegreeBattleStatsSync(playerId)
        ))
        .register("periodicSnapshot", ({ playerId, key }) => {
            const periodType = key.snapshotKind === "passWeek"
                ? domains.getPassWeekSnapshotType(key.eventId)
                : key.snapshotKind
            return domains.getSnapshot(playerId, periodType)
        })
        .register("passState", ({ playerId, key }) => (
            domains.getPlayerPassCardStateSync(playerId, key.eventId)
        ))
}
