function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseSingleContinueExpectedCount(statistics: unknown): number | null {
    if (!isObjectRecord(statistics) || !Array.isArray(statistics.zones)
        || statistics.zones.length === 0) return null

    let total = 0
    for (const zone of statistics.zones) {
        if (!isObjectRecord(zone)) return null
        const count = zone.continue_count
        if (!Number.isSafeInteger(count) || (count as number) < 0) return null
        total += count as number
        if (!Number.isSafeInteger(total)) return null
    }
    return total
}
