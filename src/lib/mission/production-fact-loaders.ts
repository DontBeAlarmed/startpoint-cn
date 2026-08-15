import {
    getMissionBattleCountersSync,
    type MissionBattleCounters,
} from "../../data/domains/mission_battle_facts"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import type { Player, PlayerQuestProgress } from "../../data/types"
import { MissionFactLoaderRegistry } from "./fact-loaders"
import {
    getPassWeekSnapshotType,
    getSnapshot,
    type SnapshotData,
} from "./snapshot"

export interface ProductionMissionFactDomains {
    readonly getPlayerSync: (playerId: number) => Player | null
    readonly getPlayerQuestProgressSync: (
        playerId: number,
        sections?: readonly number[],
    ) => Record<string, PlayerQuestProgress[]>
    readonly getMissionBattleCountersSync: (playerId: number) => MissionBattleCounters
    readonly getSnapshot: (playerId: number, periodType: string) => SnapshotData | null
    readonly getPassWeekSnapshotType: (eventId: number) => string
}

const productionDomains: ProductionMissionFactDomains = {
    getPlayerSync,
    getPlayerQuestProgressSync,
    getMissionBattleCountersSync,
    getSnapshot,
    getPassWeekSnapshotType,
}

export function createProductionMissionFactLoaderRegistry(
    domains: ProductionMissionFactDomains = productionDomains,
): MissionFactLoaderRegistry {
    return new MissionFactLoaderRegistry()
        .register("player", ({ playerId }) => {
            const player = domains.getPlayerSync(playerId)
            if (player === null) throw new Error(`Mission evaluation player ${playerId} not found`)
            return player
        })
        .register("questProgress", ({ playerId, key }) => (
            domains.getPlayerQuestProgressSync(
                playerId,
                key.sections === "all" ? undefined : key.sections,
            )
        ))
        .register("missionBattleCounters", ({ playerId }) => (
            domains.getMissionBattleCountersSync(playerId)
        ))
        .register("periodicSnapshot", ({ playerId, key }) => {
            const periodType = key.snapshotKind === "passWeek"
                ? domains.getPassWeekSnapshotType(key.eventId)
                : key.snapshotKind
            return domains.getSnapshot(playerId, periodType)
        })
}
