export function parsePositiveSafeIntegerMasterValue(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }
    if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
