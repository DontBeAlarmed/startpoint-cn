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
    challengeDungeonClearCount: number
    singleScoreMax: number
    singleClearTimeMin: number
    bossBattleClearCount: number
    skillUseCount: number
}

export interface MissionBattleResult {
    isMulti: boolean
    isHost?: boolean
    accomplished: boolean
    clearRank?: number | null
    questCategory?: number
    score?: number
    clearTime?: number
    skillUseCount?: number
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
    challengeDungeonClearCount: 0,
    singleScoreMax: 0,
    singleClearTimeMin: 0,
    bossBattleClearCount: 0,
    skillUseCount: 0,
})

export function getMissionBattleCountersSync(playerId: number): MissionBattleCounters {
    const row = getDb().prepare(`
        SELECT single_play_count, single_clear_count,
               multi_play_count, multi_clear_count,
               multi_host_clear_count, multi_guest_clear_count,
               single_rank_ss_count,
               rank_ss_count, rank_s_count, rank_a_count, rank_b_count,
               challenge_dungeon_clear_count, single_score_max, single_clear_time_min,
               boss_battle_clear_count, skill_use_count
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
        challengeDungeonClearCount: row.challenge_dungeon_clear_count,
        singleScoreMax: row.single_score_max,
        singleClearTimeMin: row.single_clear_time_min,
        bossBattleClearCount: row.boss_battle_clear_count,
        skillUseCount: row.skill_use_count,
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
    const challengeDungeonClear = result.questCategory === 13 && result.accomplished ? 1 : 0
    const singleScore = !result.isMulti
        && result.accomplished
        && typeof result.score === "number"
        && Number.isSafeInteger(result.score)
        && result.score >= 0
        ? result.score
        : 0
    const singleClearTime = !result.isMulti
        && result.accomplished
        && typeof result.clearTime === "number"
        && Number.isSafeInteger(result.clearTime)
        && result.clearTime > 0
        ? result.clearTime
        : 0
    const bossBattleClear = result.questCategory === 2 && result.accomplished ? 1 : 0
    const skillUseCount = result.accomplished
        && typeof result.skillUseCount === "number"
        && Number.isSafeInteger(result.skillUseCount)
        && result.skillUseCount >= 0
        ? result.skillUseCount
        : 0

    getDb().prepare(`
        INSERT INTO players_mission_battle_counters (
            player_id, single_play_count, single_clear_count,
            multi_play_count, multi_clear_count,
            multi_host_clear_count, multi_guest_clear_count,
            single_rank_ss_count,
            rank_ss_count, rank_s_count, rank_a_count, rank_b_count,
            challenge_dungeon_clear_count, single_score_max, single_clear_time_min,
            boss_battle_clear_count, skill_use_count
        ) VALUES (
            @player_id, @single_play_count, @single_clear_count,
            @multi_play_count, @multi_clear_count,
            @multi_host_clear_count, @multi_guest_clear_count,
            @single_rank_ss_count, @rank_ss_count, @rank_s_count,
            @rank_a_count, @rank_b_count, @challenge_dungeon_clear_count,
            @single_score_max, @single_clear_time_min,
            @boss_battle_clear_count, @skill_use_count
        )
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
            rank_b_count = rank_b_count + excluded.rank_b_count,
            challenge_dungeon_clear_count = challenge_dungeon_clear_count
                + excluded.challenge_dungeon_clear_count,
            single_score_max = MAX(single_score_max, excluded.single_score_max),
            single_clear_time_min = CASE
                WHEN single_clear_time_min = 0 THEN excluded.single_clear_time_min
                WHEN excluded.single_clear_time_min = 0 THEN single_clear_time_min
                ELSE MIN(single_clear_time_min, excluded.single_clear_time_min)
            END,
            boss_battle_clear_count = boss_battle_clear_count + excluded.boss_battle_clear_count,
            skill_use_count = skill_use_count + excluded.skill_use_count
    `).run({
        player_id: playerId,
        single_play_count: singlePlay,
        single_clear_count: singleClear,
        multi_play_count: multiPlay,
        multi_clear_count: multiClear,
        multi_host_clear_count: multiHostClear,
        multi_guest_clear_count: multiGuestClear,
        single_rank_ss_count: singleRankSs,
        rank_ss_count: rankSs,
        rank_s_count: rankS,
        rank_a_count: rankA,
        rank_b_count: rankB,
        challenge_dungeon_clear_count: challengeDungeonClear,
        single_score_max: singleScore,
        single_clear_time_min: singleClearTime,
        boss_battle_clear_count: bossBattleClear,
        skill_use_count: skillUseCount,
    })
}
