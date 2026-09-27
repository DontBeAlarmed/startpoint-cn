import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import type {
    MissionCatalogReward,
    MissionCatalogStage,
    MissionMasterDefinition,
} from "./mission-catalog"

type RawTable = Record<string, unknown>

interface CategorySource {
    readonly category: number
    readonly definitionTable: string
    readonly rewardTable: string
    readonly patternIndex: number
    readonly startIndex: number
    readonly endIndex: number
    readonly targetProgressIndex: number
    readonly firstRewardKindIndex: number
    readonly eventIdIndex?: number
    readonly patternTypeIndex?: number
    readonly requiresEventScope?: boolean
    readonly awake?: boolean
}

export interface MissionCatalogSourceEntry {
    readonly definition: MissionMasterDefinition
    readonly stages: readonly MissionCatalogStage[]
    readonly awakeCharacterId?: number
}

/**
 * One unparseable content row, identified by table and raw key. The catalog
 * fails closed on these instead of silently dropping the mission.
 */
export interface MissionCatalogRowProblem {
    readonly table: string
    readonly id: string
    readonly reason: string
}

export class MissionCatalogDataError extends Error {
    readonly problems: readonly MissionCatalogRowProblem[]

    constructor(problems: readonly MissionCatalogRowProblem[]) {
        const listed = problems
            .slice(0, 20)
            .map(problem => `${problem.table}[${problem.id}]: ${problem.reason}`)
            .join("; ")
        const suffix = problems.length > 20
            ? ` (+${problems.length - 20} more, see .problems)`
            : ""
        super(`Mission catalog content has ${problems.length} invalid row(s): ${listed}${suffix}`)
        this.name = "MissionCatalogDataError"
        this.problems = Object.freeze([...problems])
    }
}

const CATEGORY_SOURCES: readonly CategorySource[] = Object.freeze([
    { category: 1, definitionTable: "mission_regular.json", rewardTable: "mission_regular_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 2, definitionTable: "mission_daily.json", rewardTable: "mission_daily_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 3, definitionTable: "mission_event.json", rewardTable: "mission_event_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 4, definitionTable: "mission_collect_item.json", rewardTable: "mission_collect_item_reward.json", eventIdIndex: 0, patternIndex: 2, startIndex: 27, endIndex: 28, targetProgressIndex: 2, firstRewardKindIndex: 6, requiresEventScope: true },
    { category: 5, definitionTable: "mission_degree.json", rewardTable: "mission_degree_reward.json", patternIndex: 1, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 6, definitionTable: "mission_pass_daily.json", rewardTable: "mission_pass_daily_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 7, definitionTable: "mission_pass_week.json", rewardTable: "mission_pass_week_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 8, definitionTable: "mission_pass_event.json", rewardTable: "mission_pass_event_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 9, definitionTable: "mission_char_awake.json", rewardTable: "mission_char_awake_reward.json", patternIndex: 2, startIndex: 27, endIndex: 28, targetProgressIndex: 5, firstRewardKindIndex: 9, awake: true },
    { category: 10, definitionTable: "mission_weekly_def.json", rewardTable: "mission_weekly_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
])

function asTable(value: unknown): RawTable | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as RawTable
        : undefined
}

function isEmptyMasterValue(value: unknown): boolean {
    return value === undefined || value === null || value === "" || value === "(None)"
}

function parseExactSafeInteger(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined
    if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseExactFiniteNumber(value: unknown): number | undefined {
    let parsed: number
    if (typeof value === "number") {
        parsed = value
    } else {
        if (typeof value !== "string"
            || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined
        parsed = Number(value)
    }
    if (!Number.isFinite(parsed)
        || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) return undefined
    return parsed
}

function positiveSafeInteger(value: unknown): number | undefined {
    const parsed = parseExactSafeInteger(value)
    return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
    const parsed = parseExactSafeInteger(value)
    return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function optionalMasterString(value: unknown): string | undefined {
    if (isEmptyMasterValue(value)) return undefined
    return String(value)
}

function parsePattern(value: unknown): string | undefined {
    if (typeof value !== "string" || value === "(None)" || value.trim() === "") return undefined
    return value
}

function cloneAndFreeze(value: unknown): unknown {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze))
    if (value !== null && typeof value === "object") {
        return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, cloneAndFreeze(child)]),
        ))
    }
    return value
}

interface NormalizedEntries {
    readonly values: ReadonlyMap<number, unknown>
    readonly problems: readonly MissionCatalogRowProblem[]
}

function normalizeEntries(table: RawTable, tableName: string): NormalizedEntries {
    const values = new Map<number, unknown>()
    const invalidIds = new Set<number>()
    const problems: MissionCatalogRowProblem[] = []
    for (const [rawId, value] of Object.entries(table)) {
        const id = positiveSafeInteger(rawId)
        if (id === undefined) {
            problems.push({
                table: tableName,
                id: rawId,
                reason: "table key is not a positive integer id",
            })
            continue
        }
        if (invalidIds.has(id)) continue
        if (values.has(id)) {
            values.delete(id)
            invalidIds.add(id)
            problems.push({
                table: tableName,
                id: rawId,
                reason: "table key appears more than once",
            })
            continue
        }
        values.set(id, value)
    }
    return { values, problems: Object.freeze(problems) }
}

type ParsedDefinition =
    | { readonly ok: true; readonly definition: MissionMasterDefinition; readonly awakeCharacterId?: number }
    | { readonly ok: false; readonly reason: string }

function parseDefinition(
    source: CategorySource,
    missionId: number,
    rawRows: unknown,
): ParsedDefinition {
    if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) {
        return { ok: false, reason: "definition row bundle must contain exactly one row" }
    }
    const row = rawRows[0]
    const pattern = parsePattern(row[source.patternIndex])
    if (pattern === undefined) return { ok: false, reason: "pattern column is empty or (None)" }

    const eventId = source.eventIdIndex === undefined
        ? undefined
        : positiveSafeInteger(row[source.eventIdIndex])
    const patternType = source.patternTypeIndex !== undefined
        && !isEmptyMasterValue(row[source.patternTypeIndex])
        ? nonnegativeSafeInteger(row[source.patternTypeIndex])
        : undefined
    const awakeCharacterId = source.awake ? positiveSafeInteger(row[1]) : undefined
    if (source.eventIdIndex !== undefined && eventId === undefined) {
        return { ok: false, reason: "event id column is not a positive integer" }
    }
    if (source.patternTypeIndex !== undefined
        && !isEmptyMasterValue(row[source.patternTypeIndex])
        && patternType === undefined) {
        return { ok: false, reason: "pattern type column is not a non-negative integer" }
    }
    if (source.awake && awakeCharacterId === undefined) {
        return { ok: false, reason: "awake character id column is not a positive integer" }
    }

    const definition = Object.freeze({
        category: source.category,
        missionId,
        pattern,
        ...(eventId === undefined ? {} : { eventId }),
        ...(patternType === undefined ? {} : { patternType }),
        ...(source.requiresEventScope ? { requiresEventScope: true } : {}),
        enableStart: optionalMasterString(row[source.startIndex]),
        enableEnd: optionalMasterString(row[source.endIndex]),
        row: cloneAndFreeze(row) as readonly unknown[],
    })
    return { ok: true, definition, ...(awakeCharacterId === undefined ? {} : { awakeCharacterId }) }
}

type ParsedRewards =
    | { readonly ok: true; readonly rewards: readonly MissionCatalogReward[] }
    | { readonly ok: false; readonly reason: string }

function parseRewards(
    row: readonly unknown[],
    firstKindIndex: number,
): ParsedRewards {
    const result: MissionCatalogReward[] = []
    for (let slot = 0; slot < 4; slot++) {
        const base = firstKindIndex + slot * 6
        const kindIsEmpty = isEmptyMasterValue(row[base])
        const kind = kindIsEmpty ? undefined : nonnegativeSafeInteger(row[base])
        if (!kindIsEmpty && kind === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} kind is not a non-negative integer` }
        }

        const amount = isEmptyMasterValue(row[base + 1])
            ? 0
            : nonnegativeSafeInteger(row[base + 1])
        if (amount === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} amount is not a non-negative integer` }
        }
        const optionalIds = [2, 3, 4, 5].map(offset => {
            const value = row[base + offset]
            return isEmptyMasterValue(value) ? undefined : positiveSafeInteger(value)
        })
        for (let offset = 2; offset <= 5; offset++) {
            if (!isEmptyMasterValue(row[base + offset])
                && optionalIds[offset - 2] === undefined) {
                return { ok: false, reason: `reward slot ${slot + 1} id column ${offset} is not a positive integer` }
            }
        }
        if (kind === undefined) continue
        const [itemId, characterId, equipmentId, degreeId] = optionalIds
        if (amount === 0 && kind !== 6) continue
        if (kind === 1 && itemId === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} item kind is missing its item id` }
        }
        if (kind === 2 && equipmentId === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} equipment kind is missing its equipment id` }
        }
        if (kind === 4 && characterId === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} character kind is missing its character id` }
        }
        if (kind === 6 && degreeId === undefined) {
            return { ok: false, reason: `reward slot ${slot + 1} degree kind is missing its degree id` }
        }

        result.push(Object.freeze({
            kind,
            amount,
            ...(itemId === undefined ? {} : { itemId }),
            ...(characterId === undefined ? {} : { characterId }),
            ...(equipmentId === undefined ? {} : { equipmentId }),
            ...(degreeId === undefined ? {} : { degreeId }),
        }))
    }
    return { ok: true, rewards: Object.freeze(result) }
}

type ParsedStages =
    | { readonly ok: true; readonly stages: readonly MissionCatalogStage[] }
    | { readonly ok: false; readonly problems: readonly MissionCatalogRowProblem[] }

function parseStages(
    source: CategorySource,
    rawStages: unknown,
    missionId: number,
): ParsedStages {
    const problems: MissionCatalogRowProblem[] = []
    const stageTable = asTable(rawStages)
    if (!stageTable) {
        return {
            ok: false,
            problems: [{
                table: source.rewardTable,
                id: String(missionId),
                reason: "reward stage rows are not a table",
            }],
        }
    }
    const tableName = `${source.rewardTable} mission ${missionId}`
    const normalized = normalizeEntries(stageTable, tableName)
    problems.push(...normalized.problems)
    if (normalized.problems.length > 0) {
        return { ok: false, problems: Object.freeze(problems) }
    }
    if (normalized.values.size === 0) {
        problems.push({
            table: source.rewardTable,
            id: String(missionId),
            reason: "reward stage table is empty",
        })
        return { ok: false, problems: Object.freeze(problems) }
    }

    const stages: MissionCatalogStage[] = []
    for (const [stage, rawRows] of normalized.values) {
        const stageId = String(stage)
        if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) {
            problems.push({
                table: `${source.rewardTable} mission ${missionId}`,
                id: stageId,
                reason: "reward stage row bundle must contain exactly one row",
            })
            return { ok: false, problems: Object.freeze(problems) }
        }
        const row = rawRows[0]
        const missionRewardId = positiveSafeInteger(row[0])
        const targetProgress = parseExactFiniteNumber(row[source.targetProgressIndex])
        if (missionRewardId === undefined || targetProgress === undefined || targetProgress < 0) {
            problems.push({
                table: `${source.rewardTable} mission ${missionId}`,
                id: stageId,
                reason: "mission reward id or target progress column is invalid",
            })
            return { ok: false, problems: Object.freeze(problems) }
        }

        let specialReward: MissionCatalogStage["specialReward"]
        const specialKind = source.awake && !isEmptyMasterValue(row[1])
            ? nonnegativeSafeInteger(row[1])
            : undefined
        if (source.awake && !isEmptyMasterValue(row[1]) && specialKind === undefined) {
            problems.push({
                table: `${source.rewardTable} mission ${missionId}`,
                id: stageId,
                reason: "awake special reward kind is not a non-negative integer",
            })
            return { ok: false, problems: Object.freeze(problems) }
        }
        if (specialKind === 0) {
            const characterId = positiveSafeInteger(row[2])
            const boardIndex = positiveSafeInteger(row[3])
            const awakeLevel = positiveSafeInteger(row[4])
            if (characterId === undefined || boardIndex === undefined || awakeLevel === undefined) {
                problems.push({
                    table: `${source.rewardTable} mission ${missionId}`,
                    id: stageId,
                    reason: "awake special reward character/board/level column is invalid",
                })
                return { ok: false, problems: Object.freeze(problems) }
            }
            specialReward = Object.freeze({ characterId, boardIndex, awakeLevel })
        }
        const targetClearSeconds = source.awake && !isEmptyMasterValue(row[6])
            ? nonnegativeSafeInteger(row[6])
            : undefined
        if (source.awake && !isEmptyMasterValue(row[6]) && targetClearSeconds === undefined) {
            problems.push({
                table: `${source.rewardTable} mission ${missionId}`,
                id: stageId,
                reason: "awake target clear seconds column is invalid",
            })
            return { ok: false, problems: Object.freeze(problems) }
        }
        const parsedRewards = parseRewards(row, source.firstRewardKindIndex)
        if (!parsedRewards.ok) {
            problems.push({
                table: `${source.rewardTable} mission ${missionId}`,
                id: stageId,
                reason: parsedRewards.reason,
            })
            return { ok: false, problems: Object.freeze(problems) }
        }
        stages.push(Object.freeze({
            stage,
            missionRewardId,
            targetProgress,
            ...(targetClearSeconds === undefined ? {} : { targetClearSeconds }),
            rewards: parsedRewards.rewards,
            ...(specialReward === undefined ? {} : { specialReward }),
        }))
    }
    stages.sort((left, right) => (
        left.targetProgress - right.targetProgress || left.stage - right.stage
    ))
    return { ok: true, stages: Object.freeze(stages) }
}

export function parseMissionCatalogSource(
    repository: ReadonlyContentRepository,
): readonly MissionCatalogSourceEntry[] {
    const result: MissionCatalogSourceEntry[] = []
    const problems: MissionCatalogRowProblem[] = []
    for (const source of CATEGORY_SOURCES) {
        const definitionTable = asTable(repository.table(source.definitionTable))
        const rewardTable = asTable(repository.table(source.rewardTable))
        // A missing table means the whole category is not provided by this
        // content snapshot (bundled fallback); that is a skip, not a row error.
        if (!definitionTable || !rewardTable) continue
        const definitions = normalizeEntries(definitionTable, source.definitionTable)
        const rewards = normalizeEntries(rewardTable, source.rewardTable)
        problems.push(...definitions.problems, ...rewards.problems)

        for (const [missionId, rawDefinition] of definitions.values) {
            const rawStages = rewards.values.get(missionId)
            if (rawStages === undefined) {
                problems.push({
                    table: source.rewardTable,
                    id: String(missionId),
                    reason: "mission has no reward stage rows",
                })
                continue
            }
            const parsedDefinition = parseDefinition(source, missionId, rawDefinition)
            if (!parsedDefinition.ok) {
                problems.push({
                    table: source.definitionTable,
                    id: String(missionId),
                    reason: parsedDefinition.reason,
                })
                continue
            }
            const parsedStages = parseStages(source, rawStages, missionId)
            if (!parsedStages.ok) {
                problems.push(...parsedStages.problems)
                continue
            }
            result.push(Object.freeze({ ...parsedDefinition, stages: parsedStages.stages }))
        }

        for (const rewardId of rewards.values.keys()) {
            if (!definitions.values.has(rewardId)) {
                problems.push({
                    table: source.rewardTable,
                    id: String(rewardId),
                    reason: "reward stage rows exist without a mission definition",
                })
            }
        }
    }
    if (problems.length > 0) throw new MissionCatalogDataError(problems)
    return Object.freeze(result)
}
