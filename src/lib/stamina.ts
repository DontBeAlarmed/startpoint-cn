import playerRankTable from "../../assets/cdndata/player_rank_full.json";
import { getConfigSync } from "./assets";
import { getRealNowMs } from "../runtime/time/game-time";

const STAMINA_OVERFLOW_MAX = 999;

interface RankEntry { stamina: number; threshold: number; healRate: number }
const rankMap = new Map<number, RankEntry>();
const sortedDegrees: number[] = [];

for (const [degreeStr, rows] of Object.entries(playerRankTable)) {
    const degree = parseInt(degreeStr);
    const row = (rows as any[])[0];
    rankMap.set(degree, {
        stamina: parseInt(row[0]),
        threshold: parseInt(row[1]),
        healRate: parseFloat(row[2]) || 0,
    });
    sortedDegrees.push(degree);
}
sortedDegrees.sort((a, b) => a - b);

export function getMaxStamina(degreeId: number): number {
    if (degreeId <= 0) return rankMap.get(1)?.stamina ?? 22;
    return rankMap.get(degreeId)?.stamina ?? rankMap.get(250)?.stamina ?? 125;
}

export function getHealRate(degree: number): number {
    return rankMap.get(degree)?.healRate ?? 0;
}

export function computeRealTimeStamina(player: { stamina: number; staminaHealTime: Date; rankPoint: number }): number {
    const config = getConfigSync();
    const degree = getRankDegree(player.rankPoint);
    const healRate = getHealRate(degree);
    const recoverySeconds = config.stamina_recovery_seconds * (1 - healRate);
    const healSec = player.staminaHealTime.getTime() / 1000;
    const nowSec = Math.floor(getRealNowMs() / 1000);
    const elapsed = (nowSec - healSec) / recoverySeconds;
    const maxStamina = Math.max(getMaxStamina(degree), player.stamina);
    return Math.min(Math.max(0, player.stamina + Math.floor(elapsed)), maxStamina, STAMINA_OVERFLOW_MAX);
}

export function getRankDegree(rankPoint: number): number {
    let result = 1;
    for (const degree of sortedDegrees) {
        const entry = rankMap.get(degree)!;
        if (rankPoint >= entry.threshold) {
            result = degree;
        } else {
            break;
        }
    }
    return result;
}
