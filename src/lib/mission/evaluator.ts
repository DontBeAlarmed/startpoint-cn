import {
    getMissionCounterDeltaSync,
    getMissionCounterValueSync,
    type MissionCounterPeriod,
    type MissionCounterQuery,
} from "./counters"

export interface MissionEvaluationInput {
    playerId: number
    category: number
    missionId: number
    pattern: string
    definition?: any[]
    period?: MissionCounterPeriod
}

export interface MissionEvaluationResult {
    supported: boolean
    progress: number
    reason?: string
}

function cell(row: any[] | undefined, index: number): string {
    const value = row?.[index]
    if (value === undefined || value === null || value === "(None)") return ""
    return String(value)
}

function hasPopulatedFilterCells(definition?: any[]): boolean {
    for (let index = 3; index <= 24; index++) {
        if (cell(definition, index) !== "") return true
    }
    return false
}

function readCounter(playerId: number, query: MissionCounterQuery, period?: MissionCounterPeriod): number {
    return period
        ? getMissionCounterDeltaSync(playerId, period, query)
        : getMissionCounterValueSync(playerId, query)
}

function supported(progress: number): MissionEvaluationResult {
    return { supported: true, progress }
}

function unsupported(reason: string): MissionEvaluationResult {
    return { supported: false, progress: 0, reason }
}

export function evaluateMissionCounterProgress(input: MissionEvaluationInput): MissionEvaluationResult {
    const kind = parseInt(cell(input.definition, 2))
    const period = input.period
    const hasFilters = hasPopulatedFilterCells(input.definition)

    if (kind === 14 || input.pattern.startsWith("single_battle_play")) {
        if (hasFilters) return unsupported("filtered single battle mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "single" },
        }, period))
    }

    if (kind === 16 || input.pattern.startsWith("multi_battle_play")) {
        if (hasFilters) return unsupported("filtered multi battle mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "multi" },
        }, period))
    }

    if (kind === 23 || input.pattern.startsWith("battle_clear_count")) {
        if (hasFilters) return unsupported("filtered battle clear mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "any" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_dash")) {
        if (hasFilters) return unsupported("filtered battle stat mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "dash" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_power_flip")) {
        if (hasFilters) return unsupported("filtered battle stat mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "power_flip" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_skill")) {
        if (hasFilters) return unsupported("filtered battle stat mission")
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "skill" },
        }, period))
    }

    return unsupported(`unsupported mission kind ${Number.isNaN(kind) ? "unknown" : kind}`)
}
