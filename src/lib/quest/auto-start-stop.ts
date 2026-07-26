/**
 * The CN client handles 4050 inside quest start instead of its global HTTP
 * error path. Its native meaning is QuestOutOfPeriod, so this remains a
 * compatibility fallback rather than the client's normal auto-finish state.
 */
export const AUTO_START_STOP_RESULT_CODE = 4050

export function shouldStopAutoStartForStamina(
    isAutoStartMode: boolean,
    isInsufficientStamina: boolean,
): boolean {
    return isAutoStartMode && isInsufficientStamina
}
