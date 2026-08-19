import type {
    ActiveMissionReward,
    ParsedActiveMissionDefinition,
    ParsedActiveMissionEventDefinition,
    PlannedActiveMissionDefinition,
    PlannedActiveMissionRewardStage,
    PlannedActiveMissionTargetRequirement,
    ActiveMissionEvaluatorKind,
} from "./active-plan"
import {
    ACTIVE_MISSION_FACT_KINDS,
    type ActiveMissionFactKind,
} from "./active-fact-kinds"
import {
    parseActiveMissionQuestRange,
    type ActiveMissionQuestRange,
} from "./active-quest-range"
import {
    parseActiveMissionTableRows,
    parseActiveMissionTableValues,
} from "./active-plan-table"

const CN_MASTER_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const NONE_VALUES = new Set<unknown>([undefined, null, "", "(None)"])

const SUPPORTED_PATTERNS: ReadonlySet<number> = new Set([
    0, 4, 5, 7, 8, 9, 13, 14, 16, 17, 21, 23, 26, 34, 35, 36,
    39, 45, 46, 48, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 70,
    71, 72, 73, 78, 83, 84, 89, 90, 91,
])

function factKindsForPattern(
    pattern: number,
    questRange: ActiveMissionQuestRange | null,
): readonly ActiveMissionFactKind[] {
    if (!SUPPORTED_PATTERNS.has(pattern)) return Object.freeze([])

    const kinds = new Set<ActiveMissionFactKind>()
    const add = (...values: ActiveMissionFactKind[]) => values.forEach(value => kinds.add(value))
    switch (pattern) {
        case 0:
        case 39:
            add("player")
            break
        case 4:
        case 5:
        case 8:
        case 9:
        case 21:
        case 61:
            add("characters")
            break
        case 7:
        case 48:
        case 62:
            add("manaNodes")
            break
        case 14:
        case 16:
        case 17:
        case 26:
            add("battleCounters")
            break
        case 34:
        case 36:
            add("equipment")
            break
        case 35:
            add("party")
            break
        case 45:
        case 64:
        case 84:
            add("shopPurchases")
            break
        case 46:
        case 58:
        case 59:
        case 60:
        case 63:
        case 65:
        case 78:
        case 83:
            add("counters")
            break
        case 70:
            if (questRange === null) add("characterClear")
            break
        case 71:
        case 72:
        case 73:
            add("conditionalBattleFacts")
            break
        case 89:
        case 90:
        case 91:
            add("missionSpecificBattleFacts")
            break
        default:
            break
    }
    return Object.freeze([...kinds].sort((left, right) => (
        ACTIVE_MISSION_FACT_KINDS.indexOf(left) - ACTIVE_MISSION_FACT_KINDS.indexOf(right)
    )))
}

function evaluatorForPattern(pattern: number): ActiveMissionEvaluatorKind | null {
    if (!SUPPORTED_PATTERNS.has(pattern)) return null
    return pattern === 13 ? "dependency" : "static"
}

export interface ActiveMissionPlanSource {
    readonly definitions: readonly PlannedActiveMissionDefinition[]
    readonly events: ReadonlyMap<number, ParsedActiveMissionEventDefinition>
    readonly missionRows: ReadonlyMap<number, readonly unknown[]>
    readonly eventRows: ReadonlyMap<number, readonly unknown[]>
    readonly rewardStages: ReadonlyMap<number, readonly PlannedActiveMissionRewardStage[]>
}

function parseRequiredInteger(value: unknown, field: string): number {
    if (NONE_VALUES.has(value)) throw new TypeError(`Invalid Active Mission ${field}.`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid Active Mission ${field}.`)
    return parsed
}

function parseOptionalInteger(value: unknown, field: string): number | undefined {
    return NONE_VALUES.has(value) ? undefined : parseRequiredInteger(value, field)
}

function parseStageReference(
    missionIdValue: unknown,
    stageValue: unknown,
    field: string,
): { readonly missionId: number, readonly stage: number } | undefined {
    if (NONE_VALUES.has(missionIdValue)) return undefined
    const missionId = parseRequiredInteger(missionIdValue, `${field} mission id`)
    const stage = parseRequiredInteger(stageValue, `${field} stage`)
    if (missionId <= 0 || stage <= 0) throw new TypeError(`Invalid Active Mission ${field}.`)
    return { missionId, stage }
}

export function parseCnMasterDateTime(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) throw new TypeError(`Invalid CN master date time: ${value}`)

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const [year, month, day, hour, minute, second] = [
        yearText,
        monthText,
        dayText,
        hourText,
        minuteText,
        secondText,
    ].map(Number)
    if (year < 1970 || year > 2200
        || month < 1 || month > 12
        || day < 1 || day > 31
        || hour > 23 || minute > 59 || second > 59) {
        throw new TypeError(`Invalid CN master date time: ${value}`)
    }

    const utcWithoutOffset = Date.UTC(year, month - 1, day, hour, minute, second)
    const normalized = new Date(utcWithoutOffset)
    if (normalized.getUTCFullYear() !== year
        || normalized.getUTCMonth() !== month - 1
        || normalized.getUTCDate() !== day
        || normalized.getUTCHours() !== hour
        || normalized.getUTCMinutes() !== minute
        || normalized.getUTCSeconds() !== second) {
        throw new TypeError(`Invalid CN master date time: ${value}`)
    }
    return utcWithoutOffset - CN_MASTER_OFFSET_MILLISECONDS
}

export const parseJstDateTime = parseCnMasterDateTime

function parseOptionalCnMasterDateTime(value: unknown, field: string): number | undefined {
    if (NONE_VALUES.has(value)) return undefined
    if (typeof value !== "string") throw new TypeError(`Invalid Active Mission ${field}.`)
    return parseCnMasterDateTime(value)
}

export function parseActiveMissionDefinition(
    missionId: number,
    row: readonly unknown[],
): ParsedActiveMissionDefinition {
    const eventId = parseRequiredInteger(row[0], "event id")
    const phase = parseOptionalInteger(row[1], "phase")
    const stringId = row[3]
    if (typeof stringId !== "string" || stringId.length === 0) {
        throw new TypeError("Invalid Active Mission string id.")
    }
    const need = parseStageReference(row[56], row[57], "need")
    const show = parseStageReference(row[58], row[59], "show")
    const enableStartTime = parseOptionalCnMasterDateTime(row[60], "enable start time")
    const enableEndTime = parseOptionalCnMasterDateTime(row[61], "enable end time")
    const showStartTime = parseOptionalCnMasterDateTime(row[62], "show start time")
    const showEndTime = parseOptionalCnMasterDateTime(row[63], "show end time")
    return {
        missionId,
        eventId,
        ...(phase !== undefined ? { phase } : {}),
        stringId,
        ...(need ? { need } : {}),
        ...(show ? { show } : {}),
        ...(enableStartTime !== undefined ? { enableStartTime } : {}),
        ...(enableEndTime !== undefined ? { enableEndTime } : {}),
        ...(showStartTime !== undefined ? { showStartTime } : {}),
        ...(showEndTime !== undefined ? { showEndTime } : {}),
    }
}

export function parseActiveMissionEventDefinition(
    eventId: number,
    row: readonly unknown[],
): ParsedActiveMissionEventDefinition {
    const stringId = row[0]
    const maxPhase = parseOptionalInteger(row[3], "event max phase")
    const startTime = parseOptionalCnMasterDateTime(row[14], "event start time")
    if (startTime === undefined) throw new TypeError("Invalid Active Mission event start time.")
    const endTime = parseOptionalCnMasterDateTime(row[15], "event end time")
    const needQuestMultipliedId = parseOptionalInteger(row[22], "event prerequisite quest")
    return {
        eventId,
        ...(typeof stringId === "string" ? { stringId } : {}),
        kind: parseRequiredInteger(row[2], "event kind"),
        ...(maxPhase !== undefined ? { maxPhase } : {}),
        startTime,
        ...(endTime !== undefined ? { endTime } : {}),
        ...(needQuestMultipliedId !== undefined ? { needQuestMultipliedId } : {}),
    }
}

function parseTargetMissionIds(value: unknown): readonly number[] {
    if (NONE_VALUES.has(value)) return Object.freeze([])
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError("Invalid Active Mission target mission ids.")
    }
    return Object.freeze(String(value).split(",").map(item => {
        const missionId = parseRequiredInteger(item, "target mission id")
        if (missionId < 0) throw new TypeError("Invalid Active Mission target mission id.")
        return missionId
    }))
}

function buildTargetMissionRequirements(
    pattern: number,
    row: readonly unknown[],
    rewardStages: ReadonlyMap<number, readonly PlannedActiveMissionRewardStage[]>,
): readonly PlannedActiveMissionTargetRequirement[] {
    if (pattern !== 13) return Object.freeze([])
    return Object.freeze(parseTargetMissionIds(row[55]).map(missionId => {
        const stages = rewardStages.get(missionId) ?? []
        return Object.freeze({
            missionId,
            completionProgress: stages.length === 0
                ? null
                : Math.max(...stages.map(stage => stage.targetProgress)),
        })
    }))
}

function parseRewardInteger(value: unknown): number | undefined {
    if (NONE_VALUES.has(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseMissionRewardSlots(row: readonly unknown[]): readonly ActiveMissionReward[] | null {
    const result: ActiveMissionReward[] = []
    for (let slot = 0; slot < 4; slot++) {
        const base = 7 + slot * 6
        const kind = parseRewardInteger(row[base])
        if (!NONE_VALUES.has(row[base]) && kind === undefined) return null
        if (kind === undefined) continue

        const amount = parseRewardInteger(row[base + 1])
        if (amount === undefined) return null
        const itemId = parseRewardInteger(row[base + 2])
        const characterId = parseRewardInteger(row[base + 3])
        const equipmentId = parseRewardInteger(row[base + 4])
        const degreeId = parseRewardInteger(row[base + 5])
        if (amount === 0 && kind !== 6) continue
        if (kind === 1 && itemId === undefined) return null
        if (kind === 2 && equipmentId === undefined) return null
        if (kind === 4 && characterId === undefined) return null
        if (kind === 6 && degreeId === undefined) return null
        result.push(Object.freeze({
            kind,
            amount,
            ...(itemId !== undefined ? { itemId } : {}),
            ...(characterId !== undefined ? { characterId } : {}),
            ...(equipmentId !== undefined ? { equipmentId } : {}),
            ...(degreeId !== undefined ? { degreeId } : {}),
        }))
    }
    return Object.freeze(result)
}

function parseRewardStages(
    rawStages: unknown,
    missionId: number,
): readonly PlannedActiveMissionRewardStage[] {
    const stageTableName = `mission_active_reward.json mission ${missionId} stage`
    const stageValues = parseActiveMissionTableValues(rawStages, stageTableName)
    if (stageValues.size === 0) {
        throw new TypeError(`Missing ${stageTableName} definition.`)
    }
    const stages: PlannedActiveMissionRewardStage[] = []
    for (const [stage, rawRows] of stageValues) {
        if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) {
            throw new TypeError(`Invalid ${stageTableName} ID ${stage} row.`)
        }
        const row = rawRows[0] as readonly unknown[]
        const targetProgress = parseRequiredFiniteNumber(row[3], "reward target progress")
        if (targetProgress < 0) throw new TypeError(`Invalid ${stageTableName} ID ${stage} target progress.`)
        const targetClearSeconds = parseRewardInteger(row[4])
        if (!NONE_VALUES.has(row[4])
            && (targetClearSeconds === undefined || targetClearSeconds < 0)) {
            throw new TypeError(`Invalid ${stageTableName} ID ${stage} clear seconds.`)
        }
        const rewards = parseMissionRewardSlots(row)
        if (rewards === null) {
            throw new TypeError(`Invalid ${stageTableName} ID ${stage} rewards.`)
        }
        stages.push(Object.freeze({
            stage,
            targetProgress,
            ...(targetClearSeconds === undefined ? {} : { targetClearSeconds }),
            rewards,
        }))
    }
    return Object.freeze(stages.sort((left, right) => left.stage - right.stage))
}

function parseRequiredFiniteNumber(value: unknown, field: string): number {
    if (NONE_VALUES.has(value)) throw new TypeError(`Invalid Active Mission ${field}.`)
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new TypeError(`Invalid Active Mission ${field}.`)
    return parsed
}

export function buildActiveMissionPlanSource(
    missionTable: unknown,
    eventTable: unknown,
    rewardTable: unknown,
): ActiveMissionPlanSource {
    const missionTableName = "mission_active.json"
    const eventTableName = "mission_active_event.json"
    const rewardTableName = "mission_active_reward.json"
    const missionEntries = parseActiveMissionTableRows(missionTable, missionTableName)
    const missionRows = new Map(missionEntries.map(entry => [entry.id, entry.row]))
    const eventEntries = parseActiveMissionTableRows(eventTable, eventTableName)
    const events = new Map<number, ParsedActiveMissionEventDefinition>()
    const eventRows = new Map(eventEntries.map(entry => [entry.id, entry.row]))
    for (const entry of eventEntries) {
        try {
            events.set(entry.id, parseActiveMissionEventDefinition(entry.id, entry.row))
        } catch (error) {
            throw contextualError(eventTableName, entry.id, error)
        }
    }

    const rewardValues = parseActiveMissionTableValues(rewardTable, rewardTableName)
    const rewardStages = new Map<number, readonly PlannedActiveMissionRewardStage[]>()
    for (const [missionId, rawStages] of rewardValues) {
        try {
            rewardStages.set(missionId, parseRewardStages(rawStages, missionId))
        } catch (error) {
            throw contextualError(rewardTableName, missionId, error)
        }
    }
    const definitions: PlannedActiveMissionDefinition[] = []
    for (const entry of missionEntries) {
        try {
            const mission = parseActiveMissionDefinition(entry.id, entry.row)
            const pattern = parseRequiredInteger(entry.row[29], "pattern")
            const event = events.get(mission.eventId)
            if (!event) {
                throw new TypeError(
                    `Missing ${eventTableName} ID ${mission.eventId} referenced by ${missionTableName} ID ${entry.id}.`,
                )
            }
            const missionRewardStages = rewardStages.get(entry.id)
            if (missionRewardStages === undefined) {
                throw new TypeError(
                    `Missing ${rewardTableName} ID ${entry.id} referenced by ${missionTableName} ID ${entry.id}.`,
                )
            }
            const questRange = parseActiveMissionQuestRange(entry.row)
            definitions.push(Object.freeze({
                missionId: entry.id,
                pattern,
                mission,
                row: entry.row,
                rewardStages: missionRewardStages,
                questRange,
                targetMissionRequirements: buildTargetMissionRequirements(
                    pattern,
                    entry.row,
                    rewardStages,
                ),
                factKinds: factKindsForPattern(pattern, questRange),
                evaluator: evaluatorForPattern(pattern),
            }))
        } catch (error) {
            throw contextualError(missionTableName, entry.id, error)
        }
    }
    definitions.sort((left, right) => left.missionId - right.missionId)
    return {
        definitions: Object.freeze(definitions),
        events,
        missionRows,
        eventRows,
        rewardStages,
    }
}

function contextualError(tableName: string, id: number, error: unknown): TypeError {
    const detail = error instanceof Error ? error.message : String(error)
    return new TypeError(`Invalid ${tableName} ID ${id}: ${detail}`)
}
