// Mission computer core types

import type { Player, PlayerCharacter, RawPlayerQuestProgress } from "../../data/types"
import type { SnapshotData } from "./snapshot"
import type { MissionBattleCounters } from "../../data/domains/mission_battle_facts"
import type { DegreeBattleStats } from "../../data/domains/degree_battle_stats"

export interface PlayerQuestProgressEntry {
    questId: number
    finished: boolean
    clearRank: number | null | undefined
    bestElapsedTimeMs: number | undefined
    leaderCharacterId: number | undefined
    multiClearCount: number | undefined
}

/** Per-category pre-computed context — built once, read many times */
export interface CategoryContext {
    category: number
    playerId: number
    player: Player
    questProgress: Record<string, PlayerQuestProgressEntry[]>
    totalQuestClears: number
    totalStories: number
    rankCounts: Record<string, number>
    collectedItemTotals?: Record<string, number>
    degreeStats?: {
        maxCharacterLevel: number
        companionCount: number
        overLimitCount: number
        manaBoardCount: number
        bondTokenCount: number
        singleSsCount: number
        multiClearCount: number
        multiHostClearCount: number
        episodeClearCount: number
        characterLevels: ReadonlyMap<number, number>
        bondedCharacterIds: ReadonlySet<number>
        secondManaBoardNodeCount: number
        secondManaBoardCompletedCharacterIds: ReadonlySet<number>
        episodeCompletedChapters: ReadonlySet<number>
        practiceSsQuestIds: ReadonlySet<number>
        treasureShopPurchaseCount: number
        bossBattleSuperQuestByMission: ReadonlyMap<number, number>
        bossBattleClearQuestIds: ReadonlySet<number>
        expertSingleFinishedQuestIds: ReadonlySet<number>
        worldStoryFinishedQuestIds: ReadonlySet<number>
        adventFinishedQuestIds: ReadonlySet<number>
        carnivalFinishedQuestIds: ReadonlySet<number>
        hardMultiFinishedQuestIds: ReadonlySet<number>
        challengeDungeonClearCount: number
        singleScoreMax: number
        singleClearTimeMin: number
        bossBattleClearCount: number
        craftPointObtainedCount: number
        collectedItemTotals: Readonly<Record<string, number>>
        maxLevelEquipmentCount: number
        skillUseCount: number
        degreeBattleStats: DegreeBattleStats
    }
    battleCounters?: MissionBattleCounters
    snapshot?: SnapshotData | null
    passEventLoginProgress?: Record<number, number>
    /** Persisted category 3 progress used only by explicit aggregate event missions. */
    eventMissionProgress?: ReadonlyMap<number, number>
    /** Lower-bound facts reconstructed from the player's current authoritative state. */
    eventCurrentState?: {
        readonly maxCharacterLevel: number | null
        readonly manaBoardNodeCount: number | null
        readonly overLimitCount: number | null
        readonly characterEpisodeClearCount: number | null
        readonly clearedMainChapters: ReadonlySet<number> | null
        readonly equipmentAwakeningCount: number | null
        readonly hasEquippedAbilitySoul: boolean | null
    }
}

/** A mission computer handles one or more categories */
export interface MissionComputer {
    readonly name: string

    /**
     * Build pre-cached context for this category.
     * All DB I/O happens here — compute() must be pure.
     */
    buildContext(playerId: number, category: number, evaluationTime: Date): CategoryContext

    /**
     * Compute progress for a single mission.
     * NO DB calls inside — use ctx for all data.
     */
    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number
}

export type ComputerRegistry = Map<number, MissionComputer>
