interface HardMultiMissionDiagnosticInput {
    category: number
    questId: number
    accomplished: boolean
    clearRank: number | null
    clearTimeMs: number
    statistics: Record<string, unknown>
}

function formatClientChecks(value: unknown): string {
    if (value === undefined) return "<missing>"
    if (value === null) return "<null>"
    if (Array.isArray(value)) {
        const checks = value.slice(0, 32)
        const suffix = value.length > checks.length ? `...(+${value.length - checks.length})` : ""
        return `${JSON.stringify(checks)}${suffix}`
    }
    if (typeof value === "object") return `<${Array.isArray(value) ? "array" : "object"}>`
    return `<${typeof value}>`
}

export function formatHardMultiMissionDiagnostic(
    input: HardMultiMissionDiagnosticInput,
): string | null {
    if (input.category !== 26) return null
    return `[MISSION] hard_multi_finish category=${input.category}`
        + ` quest=${input.questId}`
        + ` accomplished=${input.accomplished}`
        + ` clearRank=${input.clearRank ?? "null"}`
        + ` clearTimeMs=${input.clearTimeMs}`
        + ` client_checks=${formatClientChecks(input.statistics.client_checks)}`
}
