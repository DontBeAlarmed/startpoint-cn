import playerRankTable from "../../assets/cdndata/player_rank_full.json";
import { getConfigSync } from "./assets";

const STAMINA_OVERFLOW_MAX = 999;

interface RankEntry { degree: number; stamina: number; threshold: number; healRate: number }
const rankData: RankEntry[] = [];
const staminaByDegree: Map<number, number> = new Map();

for (const [degreeStr, rows] of Object.entries(playerRankTable)) {
    const degree = parseInt(degreeStr);
    const row = (rows as any[])[0];
    const stamina = parseInt(row[0]);
    const threshold = parseInt(row[1]);
    const healRate = parseFloat(row[2]) || 0;
    rankData.push({ degree, stamina, threshold, healRate });
    staminaByDegree.set(degree, stamina);
}
rankData.sort((a, b) => a.degree - b.degree);

/**
 * Get max stamina for a given degree (rank level).
 * Falls back to degree 1 value for 0, and 250 for >250.
 */
export function getMaxStamina(degreeId: number): number {
    if (degreeId <= 0) return staminaByDegree.get(1) ?? 22;
    const s = staminaByDegree.get(degreeId);
    if (s !== undefined) return s;
    return staminaByDegree.get(250) ?? 125;
}

/**
 * Compute real-time stamina recovery from staminaHealTime to now.
 * Uses per-degree heal_rate for client-aligned recovery speed.
 * Caps at getMaxStamina(degreeId), with absolute hard cap at 999.
 */
export function computeRealTimeStamina(player: { stamina: number; staminaHealTime: Date; rankPoint: number }): number {
    const config = getConfigSync();
    const degree = getRankDegree(player.rankPoint);
    const healRate = getHealRate(degree);
    const recoverySeconds = config.stamina_recovery_seconds * (1 - healRate);
    const healSec = player.staminaHealTime.getTime() / 1000;
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsed = (nowSec - healSec) / recoverySeconds;
    const maxStamina = Math.max(getMaxStamina(degree), player.stamina);
    return Math.min(Math.max(0, player.stamina + Math.floor(elapsed)), maxStamina, STAMINA_OVERFLOW_MAX);
}

/**
 * Look up the heal_rate for a given degree from rank data.
 * Returns 0 for degrees where heal_rate is not defined.
 */
export function getHealRate(degree: number): number {
    const row = rankData.find(r => r.degree === degree);
    return row?.healRate ?? 0;
}

/**
 * Determine the player's degree ID (rank level) based on total rankPoint.
 * Returns the highest degree whose threshold is <= rankPoint.
 * Returns 1 if rankPoint is below the first rank threshold.
 */
export function getRankDegree(rankPoint: number): number {
    let result = 1;
    for (const r of rankData) {
        if (rankPoint >= r.threshold) {
            result = r.degree;
        } else {
            break;
        }
    }
    return result;
}
