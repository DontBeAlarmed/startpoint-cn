import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getDb } from "../../data/db"
import {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import {
    getActiveMissionEventMasterDefinition,
    getActiveMissionMasterDefinitions,
} from "./active-master-data"
import {
    ActiveMissionProgressDelta,
    ActiveMissionProgressState,
    getActiveMissionRewardStageIds,
    isActiveMissionAvailable,
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    settleActiveMissionProgress,
} from "./active-core"
import { getMissionRewardStageDefinition } from "./rewards"

const PATTERN_TOTAL_LOGIN_DAYS = 0
const PATTERN_TARGET_MISSION_CLEAR = 13
const PATTERN_USED_STAMINA_COUNT = 39
const PATTERN_QUEST_CLEAR = 57
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

function parseInteger(value: unknown, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return parsed
}

function parseIntegerList(value: unknown, field: string): number[] {
    if (value === "(None)" || value === undefined || value === null) return []
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    const text = String(value)
    if (text.length === 0) return []
    return text.split(",").map(item => parseInteger(item, field))
}

function requireNonEmpty(values: readonly number[], field: string): readonly number[] {
    if (values.length === 0) throw new TypeError(`Missing Active Mission ${field}.`)
    return values
}

function cartesianQuestIds(
    worlds: readonly number[],
    chapters: readonly number[],
    quests: readonly number[],
    base: number,
): number[] {
    const ids: number[] = []
    for (const world of worlds) {
        for (const chapter of chapters) {
            for (const quest of quests) {
                ids.push(base + world * 1_000_000 + chapter * 1_000 + quest)
            }
        }
    }
    return ids
}

/** 按 CN 1.8.1 ActiveMissionValues 的 row[34..37] 解析 QuestRangeReferenceIdKind。 */
export function resolveActiveMissionQuestIds(row: readonly unknown[]): number[] {
    const kind = parseInteger(row[34], "quest range kind")
    if (kind === 0 || kind === 1) {
        const worlds = requireNonEmpty(parseIntegerList(row[35], "quest worlds"), "quest worlds")
        const chapters = requireNonEmpty(parseIntegerList(row[36], "quest chapters"), "quest chapters")
        const quests = requireNonEmpty(parseIntegerList(row[37], "quest numbers"), "quest numbers")
        return [...new Set(cartesianQuestIds(worlds, chapters, quests, kind === 1 ? 10_000_000 : 0))]
    }
    if (kind === 9) {
        const eventId = parseInteger(row[35], "world story event id")
        const questNumbers = requireNonEmpty(
            parseIntegerList(row[37], "world story event quest numbers"),
            "world story event quest numbers",
        )
        return [...new Set(questNumbers.map(questNumber => eventId * 1_000 + questNumber))]
    }
    throw new TypeError(`Unsupported Active Mission quest range kind ${kind}.`)
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

function isMissionComplete(
    missionId: number,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
): boolean {
    const stageIds = getActiveMissionRewardStageIds(missionId, repository)
    if (stageIds.length === 0) return false
    const progress = activeMissions[String(missionId)]?.progress ?? 0
    return stageIds.every(stageId => {
        const reward = getMissionRewardStageDefinition(missionId, stageId, repository)
        return reward !== null && progress >= reward.targetProgress
    })
}

function computeAuthoritativeProgress(
    row: readonly unknown[],
    player: NonNullable<ReturnType<typeof getPlayerSync>>,
    finishedQuestIds: ReadonlySet<number>,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
): number | null {
    const pattern = parseInteger(row[29], "mission pattern")
    if (pattern === PATTERN_TOTAL_LOGIN_DAYS) return Math.max(0, player.totalLoginDays ?? 0)
    if (pattern === PATTERN_USED_STAMINA_COUNT) return Math.max(0, player.totalStaminaUsed ?? 0)
    if (pattern === PATTERN_QUEST_CLEAR) {
        return resolveActiveMissionQuestIds(row).filter(questId => finishedQuestIds.has(questId)).length
    }
    if (pattern === PATTERN_TARGET_MISSION_CLEAR) {
        const missionIds = parseIntegerList(row[55], "target mission ids")
        if (missionIds.length === 0) return 0
        return missionIds.every(missionId => isMissionComplete(
            missionId,
            activeMissions,
            repository,
        )) ? 1 : 0
    }
    return null
}

function isEligibleEvent(
    input: ReconcileActiveMissionFactsInput,
    eventId: number,
): boolean {
    const master = getActiveMissionEventMasterDefinition(eventId, input.repository)
    if (!master) return false
    const eventStringId = master.row[0]
    const event = parseActiveMissionEventDefinition(eventId, master.row)
    if (typeof eventStringId !== "string") return false
    if (!eventStringId.includes(COME_BACK_EVENT_STRING_ID)) return true
    return input.isEventEligible?.({
        playerId: input.playerId,
        eventId,
        eventStringId,
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
        const finishedQuestIds = new Set(Object.values(questProgress).flatMap(progressList => (
            progressList.filter(progress => progress.finished).map(progress => progress.questId)
        )))
        const activeMissions = normalizeActiveMissions(getPlayerActiveMissionsSync(input.playerId))
        const definitions = [...getActiveMissionMasterDefinitions(input.repository)]
            .sort((left, right) => left.missionId - right.missionId)
        const deltas = new Map<number, { progress: number, stages: Set<number> }>()

        // 事实只会单调增加；固定点确保同一次 /load 内 phase 与目标任务依赖可继续推进。
        for (let pass = 0; pass <= definitions.length; pass++) {
            let changed = false
            for (const definition of definitions) {
                let authoritativeProgress: number | null
                try {
                    const mission = parseActiveMissionDefinition(definition.missionId, definition.row)
                    if (!isEligibleEvent(input, mission.eventId)) continue
                    if (!isActiveMissionAvailable(definition.missionId, {
                        repository: input.repository,
                        now: input.now,
                        activeMissions,
                        questProgress,
                    })) continue
                    authoritativeProgress = computeAuthoritativeProgress(
                        definition.row,
                        player,
                        finishedQuestIds,
                        activeMissions,
                        input.repository,
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
                    { repository: input.repository },
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
