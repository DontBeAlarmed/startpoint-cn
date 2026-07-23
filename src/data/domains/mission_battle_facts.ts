import { getDb } from "../db"

export interface MissionBattleCounters {
    singlePlayCount: number
    singleClearCount: number
    multiPlayCount: number
    multiClearCount: number
    multiHostClearCount: number
    multiGuestClearCount: number
    singleRankSsCount: number
    rankSsCount: number
    rankSCount: number
    rankACount: number
    rankBCount: number
}

export interface MissionBattleResult {
    isMulti: boolean
    isHost?: boolean
    accomplished: boolean
    clearRank?: number | null
}

const EMPTY_COUNTERS: Readonly<MissionBattleCounters> = Object.freeze({
    singlePlayCount: 0,
    singleClearCount: 0,
    multiPlayCount: 0,
    multiClearCount: 0,
    multiHostClearCount: 0,
    multiGuestClearCount: 0,
    singleRankSsCount: 0,
    rankSsCount: 0,
    rankSCount: 0,
    rankACount: 0,
    rankBCount: 0,
})

export function getMissionBattleCountersSync(playerId: number): MissionBattleCounters {
    const row = getDb().prepare(`
        SELECT single_play_count, single_clear_count,
               multi_play_count, multi_clear_count,
               multi_host_clear_count, multi_guest_clear_count,
               single_rank_ss_count,
               rank_ss_count, rank_s_count, rank_a_count, rank_b_count
        FROM players_mission_battle_counters
        WHERE player_id = ?
    `).get(playerId) as Record<string, number> | undefined
    if (!row) return { ...EMPTY_COUNTERS }
    return {
        singlePlayCount: row.single_play_count,
        singleClearCount: row.single_clear_count,
        multiPlayCount: row.multi_play_count,
        multiClearCount: row.multi_clear_count,
        multiHostClearCount: row.multi_host_clear_count,
        multiGuestClearCount: row.multi_guest_clear_count,
        singleRankSsCount: row.single_rank_ss_count,
        rankSsCount: row.rank_ss_count,
        rankSCount: row.rank_s_count,
        rankACount: row.rank_a_count,
        rankBCount: row.rank_b_count,
    }
}

export function recordMissionBattleResultSync(
    playerId: number,
    result: MissionBattleResult,
): void {
    const singlePlay = result.isMulti ? 0 : 1
    const singleClear = !result.isMulti && result.accomplished ? 1 : 0
    const multiPlay = result.isMulti ? 1 : 0
    const multiClear = result.isMulti && result.accomplished ? 1 : 0
    const multiHostClear = multiClear && result.isHost === true ? 1 : 0
    const multiGuestClear = multiClear && result.isHost === false ? 1 : 0
    const singleRankSs = !result.isMulti && result.accomplished && result.clearRank === 5 ? 1 : 0
    const rankSs = result.accomplished && result.clearRank === 5 ? 1 : 0
    const rankS = result.accomplished && result.clearRank === 4 ? 1 : 0
    const rankA = result.accomplished && result.clearRank === 3 ? 1 : 0
    const rankB = result.accomplished && result.clearRank === 2 ? 1 : 0

    getDb().prepare(`
        INSERT INTO players_mission_battle_counters (
            player_id, single_play_count, single_clear_count,
            multi_play_count, multi_clear_count,
            multi_host_clear_count, multi_guest_clear_count,
            single_rank_ss_count,
            rank_ss_count, rank_s_count, rank_a_count, rank_b_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            single_play_count = single_play_count + excluded.single_play_count,
            single_clear_count = single_clear_count + excluded.single_clear_count,
            multi_play_count = multi_play_count + excluded.multi_play_count,
            multi_clear_count = multi_clear_count + excluded.multi_clear_count,
            multi_host_clear_count = multi_host_clear_count + excluded.multi_host_clear_count,
            multi_guest_clear_count = multi_guest_clear_count + excluded.multi_guest_clear_count,
            single_rank_ss_count = single_rank_ss_count + excluded.single_rank_ss_count,
            rank_ss_count = rank_ss_count + excluded.rank_ss_count,
            rank_s_count = rank_s_count + excluded.rank_s_count,
            rank_a_count = rank_a_count + excluded.rank_a_count,
            rank_b_count = rank_b_count + excluded.rank_b_count
    `).run(
        playerId,
        singlePlay,
        singleClear,
        multiPlay,
        multiClear,
        multiHostClear,
        multiGuestClear,
        singleRankSs,
        rankSs,
        rankS,
        rankA,
        rankB,
    )
}
