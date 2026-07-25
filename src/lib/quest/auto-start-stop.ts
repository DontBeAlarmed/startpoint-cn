/**
 * The CN client already treats 4050 as a non-fatal return-to-party-select
 * result for quest start. It is the only client-compatible stop signal that
 * does not require a client change.
 */
export const AUTO_START_STOP_RESULT_CODE = 4050

export function shouldStopAutoStartForStamina(
    isAutoStartMode: boolean,
    isInsufficientStamina: boolean,
): boolean {
    return isAutoStartMode && isInsufficientStamina
}
