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

function getQuestFilter(definition?: any[]): { questCategory?: number; questId?: number } {
    const questCategory = parseInt(cell(definition, 7))
    const questId = parseInt(cell(definition, 8))
    return {
        questCategory: Number.isNaN(questCategory) ? undefined : questCategory,
        questId: Number.isNaN(questId) ? undefined : questId,
    }
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

    if (kind === 14 || input.pattern.startsWith("single_battle_play")) {
        const filter = getQuestFilter(input.definition)
        if (filter.questCategory !== undefined && filter.questId !== undefined) {
            return supported(readCounter(input.playerId, {
                dimension: "battle.quest_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { questCategory: filter.questCategory, questId: filter.questId, mode: "single" },
            }, period))
        }
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "single" },
        }, period))
    }

    if (kind === 16 || input.pattern.startsWith("multi_battle_play")) {
        const filter = getQuestFilter(input.definition)
        if (filter.questCategory !== undefined && filter.questId !== undefined) {
            return supported(readCounter(input.playerId, {
                dimension: "battle.quest_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { questCategory: filter.questCategory, questId: filter.questId, mode: "multi" },
            }, period))
        }
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "multi" },
        }, period))
    }

    if (kind === 23 || input.pattern.startsWith("battle_clear_count")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "any" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_dash")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "dash" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_power_flip")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "power_flip" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_skill")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "skill" },
        }, period))
    }

    return unsupported(`unsupported mission kind ${Number.isNaN(kind) ? "unknown" : kind}`)
}
