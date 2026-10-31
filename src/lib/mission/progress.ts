export const MAX_CLIENT_PROGRESS_DELTA = 100

export function addMissionProgressDelta(current: number, delta: number): number | null {
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta <= 0 || delta > MAX_CLIENT_PROGRESS_DELTA) {
        return null
    }
    if (!Number.isFinite(current) || current < 0) current = 0
    const next = current + delta
    return Number.isSafeInteger(next) ? next : null
}
