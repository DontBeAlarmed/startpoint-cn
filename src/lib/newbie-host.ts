import { getAccountFromPlayerIdSync, getPlayerSync } from "../data/domains/player"
import type { Player } from "../data/types"
import { getCurrencyCapacityPolicySync } from "./config-content"
import { getRankDegree } from "./stamina"

const DAY_MS = 24 * 60 * 60 * 1000

export interface NewbieHostPolicy {
    readonly maxRank: number
    readonly maxAccountAgeDays: number
}

/**
 * 官方「新手组队战斗」的房主资格（2026-10-05 官方公告）：
 * RANK ≤ newbie_rank 或 建号 ≤ newbie_days 天。条件在每次 /start 时
 * 重新求值（官方"条件每天刷新"由业务日推进自然覆盖）。两个阈值来自
 * assets/config.json 的 newbie_rank / newbie_days（80 / 30，公告口径）。
 */
export function newbieHostPolicySync(): NewbieHostPolicy {
    const policy = getCurrencyCapacityPolicySync()
    return {
        maxRank: policy.newbieRank,
        maxAccountAgeDays: policy.newbieDays,
    }
}

export function isNewbieHostSync(
    hostPlayerId: number,
    player: Player | null = getPlayerSync(hostPlayerId),
    nowMs: number = Date.now(),
): boolean {
    if (!player) return false
    const { maxRank, maxAccountAgeDays } = newbieHostPolicySync()
    if (maxRank <= 0 && maxAccountAgeDays <= 0) return false
    if (maxRank > 0 && getRankDegree(player.rankPoint || 0) <= maxRank) return true

    const account = getAccountFromPlayerIdSync(hostPlayerId)
    const startedAt = account?.firstLoginTime?.getTime()
        ?? account?.regTime?.getTime()
        ?? Number.NaN
    if (maxAccountAgeDays > 0 && Number.isFinite(startedAt)) {
        if (nowMs >= startedAt && nowMs - startedAt <= maxAccountAgeDays * DAY_MS) return true
    }
    return false
}
