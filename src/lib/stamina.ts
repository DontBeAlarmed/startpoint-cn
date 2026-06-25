import playerRankTable from "../../assets/cdndata/player_rank.json";
import { getConfigSync } from "./assets";
import { Player } from "../data/types";

const MAX_STAMINA = 999;
const rankData: { degree: number; threshold: number }[] = [];

// Build sorted rank table once at import time
for (const [degreeStr, rows] of Object.entries(playerRankTable)) {
    const degree = parseInt(degreeStr);
    const row = (rows as any[])[0];
    const threshold = parseInt(row[1]);
    rankData.push({ degree, threshold });
}
rankData.sort((a, b) => a.degree - b.degree);

/**
 * Compute real-time stamina recovery from staminaHealTime to now.
 * Cap at MAX_STAMINA (999).
 */
export function computeRealTimeStamina(player: { stamina: number; staminaHealTime: Date }): number {
    const config = getConfigSync();
    const recoverySeconds = config.stamina_recovery_seconds; // 300 = 5 min/pt
    const healSec = player.staminaHealTime.getTime() / 1000;
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsed = (nowSec - healSec) / recoverySeconds;
    return Math.min(Math.max(0, player.stamina + Math.floor(elapsed)), MAX_STAMINA);
}

/**
 * Determine the player's degree ID (rank level) based on total rankPoint.
 * Returns the highest degree whose threshold is <= rankPoint.
 * Returns 1 if rankPoint is below the first rank threshold (101).
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
