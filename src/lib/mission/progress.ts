export function addMissionProgressDelta(current: number, delta: number): number | null {
    if (!Number.isInteger(delta) || delta <= 0) return null
    if (!Number.isFinite(current) || current < 0) current = 0
    return current + delta
}
