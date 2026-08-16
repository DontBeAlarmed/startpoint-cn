// Periodic snapshot — stores counter baselines for daily/weekly mission reset

import { getDb } from "../../data/db"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import type { Player } from "../../data/types"

export interface SnapshotData {
    questClears: number
    staminaUsed: number
    rankSs: number
    rankS: number
    rankA: number
    rankB: number
    singlePlayCount: number
    singleClearCount: number
    multiPlayCount: number
    multiClearCount: number
    multiHostClearCount: number
    multiGuestClearCount: number
    dashCount: number
    powerFlipCount: number
    loginDays: number
}

export function getPassWeekSnapshotType(eventId: number): string {
    return `pass-week:${eventId}`
}

export function buildPeriodicSnapshotData(
    playerId: number,
    player: Pick<Player, "totalStaminaUsed" | "totalDashes" | "totalPowerflips" | "totalLoginDays">,
    questClears: number,
): SnapshotData {
    const counters = getMissionBattleCountersSync(playerId)
    return {
        questClears,
        staminaUsed: player.totalStaminaUsed ?? 0,
        rankSs: counters.rankSsCount,
        rankS: counters.rankSCount,
        rankA: counters.rankACount,
        rankB: counters.rankBCount,
        singlePlayCount: counters.singlePlayCount,
        singleClearCount: counters.singleClearCount,
        multiPlayCount: counters.multiPlayCount,
        multiClearCount: counters.multiClearCount,
        multiHostClearCount: counters.multiHostClearCount,
        multiGuestClearCount: counters.multiGuestClearCount,
        dashCount: player.totalDashes ?? 0,
        powerFlipCount: player.totalPowerflips ?? 0,
        loginDays: player.totalLoginDays ?? 0,
    }
}

export function initializePeriodicMissionSnapshots(
    playerId: number,
    player: Pick<Player, "totalStaminaUsed" | "totalDashes" | "totalPowerflips" | "totalLoginDays">,
    options: { countCurrentLoginDay?: boolean } = {},
): void {
    const baseline = buildPeriodicSnapshotData(playerId, player, 0)
    takeSnapshot(playerId, "daily", baseline)
    takeSnapshot(playerId, "weekly", {
        ...baseline,
        loginDays: options.countCurrentLoginDay
            ? Math.max(0, baseline.loginDays - 1)
            : baseline.loginDays,
    })
}

export function takeSnapshot(playerId: number, periodType: string, data: SnapshotData): void {
    getDb().prepare(`
    INSERT OR REPLACE INTO players_periodic_snapshots
        (player_id, period_type, quest_clears, stamina_used, rank_ss, rank_s, rank_a, rank_b,
         single_play_count, single_clear_count, multi_play_count, multi_clear_count,
         multi_host_clear_count, multi_guest_clear_count, dash_count, power_flip_count,
         login_days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
        playerId, periodType,
        data.questClears, data.staminaUsed,
        data.rankSs, data.rankS, data.rankA, data.rankB,
        data.singlePlayCount, data.singleClearCount,
        data.multiPlayCount, data.multiClearCount,
        data.multiHostClearCount, data.multiGuestClearCount,
        data.dashCount, data.powerFlipCount, data.loginDays,
    )
}

export function getSnapshot(playerId: number, periodType: string): SnapshotData | null {
    const row = getDb().prepare(`
    SELECT quest_clears, stamina_used, rank_ss, rank_s, rank_a, rank_b,
           single_play_count, single_clear_count, multi_play_count, multi_clear_count,
           multi_host_clear_count, multi_guest_clear_count, dash_count, power_flip_count,
           login_days
    FROM players_periodic_snapshots
    WHERE player_id = ? AND period_type = ?
    `).get(playerId, periodType) as Record<string, number> | undefined
    if (!row) return null
    return {
        questClears: row.quest_clears,
        staminaUsed: row.stamina_used,
        rankSs: row.rank_ss,
        rankS: row.rank_s,
        rankA: row.rank_a,
        rankB: row.rank_b,
        singlePlayCount: row.single_play_count,
        singleClearCount: row.single_clear_count,
        multiPlayCount: row.multi_play_count,
        multiClearCount: row.multi_clear_count,
        multiHostClearCount: row.multi_host_clear_count,
        multiGuestClearCount: row.multi_guest_clear_count,
        dashCount: row.dash_count,
        powerFlipCount: row.power_flip_count,
        loginDays: row.login_days,
    }
}

export function getSnapshots(
    playerId: number,
    periodTypes: readonly string[],
): ReadonlyMap<string, SnapshotData> {
    const normalizedTypes = [...new Set(periodTypes)]
    if (normalizedTypes.length === 0) return new Map()
    const placeholders = normalizedTypes.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT period_type, quest_clears, stamina_used, rank_ss, rank_s, rank_a, rank_b,
               single_play_count, single_clear_count, multi_play_count, multi_clear_count,
               multi_host_clear_count, multi_guest_clear_count, dash_count, power_flip_count,
               login_days
        FROM players_periodic_snapshots
        WHERE player_id = ? AND period_type IN (${placeholders})
    `).all(playerId, ...normalizedTypes) as Array<Record<string, number> & { period_type: string }>
    return new Map(rows.map(row => [row.period_type, {
        questClears: row.quest_clears,
        staminaUsed: row.stamina_used,
        rankSs: row.rank_ss,
        rankS: row.rank_s,
        rankA: row.rank_a,
        rankB: row.rank_b,
        singlePlayCount: row.single_play_count,
        singleClearCount: row.single_clear_count,
        multiPlayCount: row.multi_play_count,
        multiClearCount: row.multi_clear_count,
        multiHostClearCount: row.multi_host_clear_count,
        multiGuestClearCount: row.multi_guest_clear_count,
        dashCount: row.dash_count,
        powerFlipCount: row.power_flip_count,
        loginDays: row.login_days,
    }]))
}
