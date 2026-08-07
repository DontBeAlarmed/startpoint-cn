// Stage threshold data — from CDN reward tables

import bundledRegularRewards from "../../../assets/mission_regular_reward.json"
import bundledDailyRewards from "../../../assets/mission_daily_reward.json"
import bundledEventRewards from "../../../assets/mission_event_reward.json"
import bundledDegreeRewards from "../../../assets/mission_degree_reward.json"
import bundledCollectItemRewards from "../../../assets/mission_collect_item_reward.json"
import bundledWeeklyRewards from "../../../assets/mission_weekly_reward.json"
import bundledCharAwakeRewards from "../../../assets/mission_char_awake_reward.json"
import bundledPassDailyRewards from "../../../assets/mission_pass_daily_reward.json"
import bundledPassWeekRewards from "../../../assets/mission_pass_week_reward.json"
import bundledPassEventRewards from "../../../assets/mission_pass_event_reward.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"

interface MissionStage {
    stage: number
    targetProgress: number
}

function buildLookup(
    rewardTable: Record<string, Record<string, any>>,
    targetProgressIndex: number
): Record<string, MissionStage[]> {
    const result: Record<string, MissionStage[]> = {}
    for (const [missionId, stages] of Object.entries(rewardTable)) {
        const list: MissionStage[] = []
        for (const [stageStr, rows] of Object.entries(stages)) {
            const row = (rows as any[])[0]
            const targetProgress = parseInt(row[targetProgressIndex] || "0")
            const stage = parseInt(stageStr)
            list.push({ stage, targetProgress })
        }
        list.sort((a, b) => a.targetProgress - b.targetProgress)
        result[missionId] = list
    }
    return result
}

type RewardTable = Record<string, Record<string, any>>

interface MissionStageSource {
    readonly tableName: string
    readonly bundledBeforeInitialization: RewardTable
    readonly targetProgressIndex: number
}

const STAGE_SOURCE_BY_CATEGORY: Readonly<Record<number, MissionStageSource>> = {
    1: { tableName: "mission_regular_reward.json", bundledBeforeInitialization: bundledRegularRewards, targetProgressIndex: 1 },
    2: { tableName: "mission_daily_reward.json", bundledBeforeInitialization: bundledDailyRewards, targetProgressIndex: 1 },
    3: { tableName: "mission_event_reward.json", bundledBeforeInitialization: bundledEventRewards, targetProgressIndex: 1 },
    4: { tableName: "mission_collect_item_reward.json", bundledBeforeInitialization: bundledCollectItemRewards, targetProgressIndex: 2 },
    5: { tableName: "mission_degree_reward.json", bundledBeforeInitialization: bundledDegreeRewards, targetProgressIndex: 1 },
    6: { tableName: "mission_pass_daily_reward.json", bundledBeforeInitialization: bundledPassDailyRewards, targetProgressIndex: 1 },
    7: { tableName: "mission_pass_week_reward.json", bundledBeforeInitialization: bundledPassWeekRewards, targetProgressIndex: 1 },
    8: { tableName: "mission_pass_event_reward.json", bundledBeforeInitialization: bundledPassEventRewards, targetProgressIndex: 1 },
    9: { tableName: "mission_char_awake_reward.json", bundledBeforeInitialization: bundledCharAwakeRewards, targetProgressIndex: 5 },
    10: { tableName: "mission_weekly_reward.json", bundledBeforeInitialization: bundledWeeklyRewards, targetProgressIndex: 1 },
}

const stageLookupByTable = new WeakMap<
    RewardTable,
    Map<number, Record<string, MissionStage[]>>
>()

function getMissionStageLookup(
    category: number,
    repository?: ReadonlyContentRepository,
): Record<string, MissionStage[]> | undefined {
    const source = STAGE_SOURCE_BY_CATEGORY[category]
    if (!source) return undefined
    const table = repository
        ? repository.table<RewardTable>(source.tableName)
        : getRuntimeContentTableSync(source.tableName, source.bundledBeforeInitialization)
    let lookupByTargetIndex = stageLookupByTable.get(table)
    const cached = lookupByTargetIndex?.get(source.targetProgressIndex)
    if (cached) return cached
    const lookup = buildLookup(table, source.targetProgressIndex)
    if (!lookupByTargetIndex) {
        lookupByTargetIndex = new Map()
        stageLookupByTable.set(table, lookupByTargetIndex)
    }
    lookupByTargetIndex.set(source.targetProgressIndex, lookup)
    return lookup
}

export function getMissionIdsByCategory(category: number, repository?: ReadonlyContentRepository): number[] {
    const lookup = getMissionStageLookup(category, repository)
    if (!lookup) return []
    return Object.keys(lookup).map(Number)
}

export function getCurrentStage(category: number, missionId: number, progress: number, repository?: ReadonlyContentRepository): number {
    const stages = getMissionStageLookup(category, repository)?.[String(missionId)]
    if (!stages || stages.length === 0) return 1
    let current = stages[stages.length - 1].stage
    for (const s of stages) {
        if (progress < s.targetProgress) {
            current = s.stage
            break
        }
    }
    return current
}

export function getCompletedStageNumbers(category: number, missionId: number, progress: number, repository?: ReadonlyContentRepository): number[] {
    const stages = getMissionStageLookup(category, repository)?.[String(missionId)]
    if (!stages) return []
    return stages.filter(s => progress >= s.targetProgress).map(s => s.stage)
}

export function isMissionProgressComplete(category: number, missionId: number, progress: number, repository?: ReadonlyContentRepository): boolean {
    const stages = getMissionStageLookup(category, repository)?.[String(missionId)]
    return !!stages?.length && stages.every(stage => progress >= stage.targetProgress)
}

export function getMissionStageIds(category: number, missionId: number, repository?: ReadonlyContentRepository): number[] {
    const stages = getMissionStageLookup(category, repository)?.[String(missionId)]
    if (!stages) return []
    return stages.map(s => s.stage)
}
