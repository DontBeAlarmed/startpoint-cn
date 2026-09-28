import { getStaminaPolicySync } from "./config-content"
import { getPlayerRankContent } from "./player-rank-content"
import { getRealNowMs } from "../runtime/time/game-time";

export const STAMINA_OVERFLOW_MAX = 999;

export function addStaminaWithOverflowCap(currentStamina: number, staminaIncrease: number): number {
    return Math.min(currentStamina + staminaIncrease, STAMINA_OVERFLOW_MAX);
}

export function getMaxStamina(degreeId: number): number {
    return getPlayerRankContent().getMaxStamina(degreeId)
}

export function getHealRate(degree: number): number {
    return getPlayerRankContent().getHealRate(degree)
}

export function computeRealTimeStamina(player: { stamina: number; staminaHealTime: Date; rankPoint: number }): number {
    const degree = getRankDegree(player.rankPoint);
    const healRate = getHealRate(degree);
    const recoverySeconds = getStaminaPolicySync().recoverySeconds * (1 - healRate);
    const healSec = player.staminaHealTime.getTime() / 1000;
    const nowSec = Math.floor(getRealNowMs() / 1000);
    const elapsed = (nowSec - healSec) / recoverySeconds;
    const maxStamina = Math.max(getMaxStamina(degree), player.stamina);
    const recoveryGain = Math.max(0, Math.floor(elapsed));
    return Math.min(Math.max(0, player.stamina + recoveryGain), maxStamina, STAMINA_OVERFLOW_MAX);
}

export function getRankDegree(rankPoint: number): number {
    return getPlayerRankContent().getRankDegree(rankPoint)
}
