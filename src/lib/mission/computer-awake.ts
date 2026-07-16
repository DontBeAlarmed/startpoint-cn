// Character awakening mission computer (category 9)

import { getPlayerCharacterClearSync } from "../../data/domains/character_clear"
import { getPlayerCharacterSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"
import type { MissionComputer, CategoryContext } from "./types"
import type { PlayerCharacter } from "../../data/types"
import charAwakeDefs from "../../../assets/mission_char_awake.json"

// Slot 1 missions that count story reading (not party clears)
const STORY_MISSION_IDS = new Set<number>(
    Object.entries(charAwakeDefs)
        .filter(([, rows]) => /阅读|剧情/.test(rows[0][3]))
        .map(([mid]) => Number(mid))
)

// ─── Awake-specific context (extends base) ───

interface AwakeContext extends CategoryContext {
    charClears: Map<string, number>
    leaderClears: Map<string, number>
    multiClears: Map<string, number>
    leaderMultiClears: Map<string, number>
    leaderPowerflips: Map<string, number>
    coClears: Map<string, number>
    raceClears: Map<string, number>
    charData: Map<string, PlayerCharacter>
}

// ─── Special mission tables ───

interface QuestClearTarget {
    category: number
    questIds: number[]
    timeLimitMs?: number
    leaderCharId?: number
}

const QUEST_CLEAR_MAP: Map<number, QuestClearTarget> = new Map([
    [1110013, { category: 2, questIds: [1028004], leaderCharId: 111001 }],
    [1310052, { category: 15, questIds: [96], leaderCharId: 131005 }],
    [1410032, { category: 2, questIds: [1020003] }],
    [2110013, { category: 2, questIds: [1028004], leaderCharId: 211001 }],
    [2310013, { category: 2, questIds: [1010004], timeLimitMs: 90000, leaderCharId: 231001 }],
    [2510032, { category: 13, questIds: [1020, 1023, 1026, 1029, 1032, 1035, 1038], leaderCharId: 251003 }],
    [2510033, { category: 13, questIds: [1020, 1023, 1026, 1029, 1032, 1035, 1038], timeLimitMs: 180000, leaderCharId: 251003 }],
    [2630023, { category: 19, questIds: [100100004, 100401004], leaderCharId: 151006 }],
])

const BOND_TOKEN_MISSION_IDS = new Set([1410033, 2210043, 2510043, 2610073])
const LEADER_REQUIRED_IDS = new Set([1510062, 1610022, 1610023, 2610072])
const COOP_MISSION_IDS = new Set([1310053, 1510063])
const COMBO_MISSION_IDS = new Set([1210013])
const POWERFLIP_CHAR_IDS = new Set([1210012])

/** Mission 2310012: 人+龙+魔 race composition */
const RACE_MISSION_IDS: Map<number, string> = new Map([
    [2310012, "Beast+Dragon+Human"],  // 人(Human)+龙(Dragon)+魔(Beast) — tentative mapping
])

// Multi-character party missions: mission_id → required character IDs (from col[24])
const MULTI_CHAR_MISSIONS: Map<number, number[]> = new Map([
    [2110012, [211001, 231001]],
    [2210042, [10, 221004]],
    [2410632, [241063, 243007]],
    [2410633, [241063, 243007, 361009]],
    [2510042, [251004, 1]],
    [3310032, [331003, 1]],
    [3310033, [331003, 10]],
])

// ─── Computer ───

function coClearKey(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`
}

function buildAwakeContext(playerId: number): AwakeContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)
    const allChars = getPlayerCharactersSync(playerId)

    let totalQuestClears = 0, ssClears = 0, sClears = 0, aClears = 0, bClears = 0, totalStories = 0
    const questProgress: CategoryContext["questProgress"] = {}

    for (const [section, quests] of Object.entries(questProgressRaw)) {
        const list: CategoryContext["questProgress"][string] = []
        for (const qp of quests) {
            list.push({
                questId: qp.questId, finished: qp.finished, clearRank: qp.clearRank,
                bestElapsedTimeMs: qp.bestElapsedTimeMs, leaderCharacterId: qp.leaderCharacterId,
                multiClearCount: qp.multiClearCount,
            })
            if (qp.finished) {
                totalQuestClears++
                if (section === '3') totalStories++
                if (qp.clearRank === 6) ssClears++
                else if (qp.clearRank === 5) sClears++
                else if (qp.clearRank === 4) aClears++
                else if (qp.clearRank === 3) bClears++
            }
        }
        questProgress[section] = list
    }

    const charClears = new Map<string, number>()
    const leaderClears = new Map<string, number>()
    const multiClears = new Map<string, number>()
    const leaderMultiClears = new Map<string, number>()
    const leaderPowerflips = new Map<string, number>()
    const charData = new Map<string, PlayerCharacter>()
    for (const [cid, char] of Object.entries(allChars)) {
        charData.set(cid, char)
        const row = getPlayerCharacterClearSync(playerId, Number(cid))
        charClears.set(cid, row.clear_count)
        leaderClears.set(cid, row.leader_clear_count)
        multiClears.set(cid, row.multi_count)
        leaderMultiClears.set(cid, row.leader_multi_count)
        leaderPowerflips.set(cid, row.leader_power_flip_count)
    }

    // Pre-fetch co-clear counts for multi-char missions
    const coClears = new Map<string, number>()
    const rows = getDb().prepare(`
    SELECT char_id_a, char_id_b, co_clear_count FROM players_party_member_co_clears
    WHERE player_id = ?
    `).all(playerId) as { char_id_a: number; char_id_b: number; co_clear_count: number }[]
    for (const r of rows) {
        coClears.set(coClearKey(r.char_id_a, r.char_id_b), r.co_clear_count)
    }

    // Pre-fetch race clears for race-composition missions
    const raceClears = new Map<string, number>()
    const raceRows = getDb().prepare(`
    SELECT race_key, clear_count FROM players_party_race_clears
    WHERE player_id = ?
    `).all(playerId) as { race_key: string; clear_count: number }[]
    for (const r of raceRows) {
        raceClears.set(r.race_key, r.clear_count)
    }

    return {
        playerId, player, questProgress,
        totalQuestClears, totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
        charClears, leaderClears, multiClears, leaderMultiClears,
        leaderPowerflips, coClears, raceClears, charData,
    }
}

export const AwakeComputer: MissionComputer = {
    name: "Awake",

    buildContext(playerId: number, _category: number): AwakeContext {
        return buildAwakeContext(playerId)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const actx = ctx as AwakeContext
        const charId = getCharacterIdFromMission(missionId)
        const lastDigit = missionId % 10

        // Quest-clear missions (checked first, independent of lastDigit)
        const qc = QUEST_CLEAR_MAP.get(missionId)
        if (qc) {
            const progress = ctx.questProgress[String(qc.category)]
            if (!progress) return 0
            const matches = progress.filter(q => qc.questIds.includes(q.questId) && q.finished)
            if (matches.length === 0) return 0
            if (qc.timeLimitMs) {
                const limit = qc.timeLimitMs
                if (!matches.some(q => (q.bestElapsedTimeMs ?? Infinity) <= limit)) return 0
            }
            if (qc.leaderCharId) {
                if (!matches.some(q => q.leaderCharacterId === qc.leaderCharId)) return 0
            }
            return 1
        }

        // Race-composition missions (e.g., 人+龙+魔)
        const raceKey = RACE_MISSION_IDS.get(missionId)
        if (raceKey) {
            return actx.raceClears.get(raceKey) ?? 0
        }

        // Multi-character party missions
        const reqChars = MULTI_CHAR_MISSIONS.get(missionId)
        if (reqChars) {
            // Check min co_clear_count across all pairs
            let minCo = Infinity
            for (let i = 0; i < reqChars.length - 1; i++) {
                for (let j = i + 1; j < reqChars.length; j++) {
                    const count = actx.coClears.get(coClearKey(reqChars[i], reqChars[j])) ?? 0
                    if (count < minCo) minCo = count
                }
            }
            return minCo === Infinity ? 0 : minCo
        }

        const isLeaderRequired = LEADER_REQUIRED_IDS.has(missionId)

        switch (lastDigit) {
            case AwakeType.STORY_READ:
                return computeStoryOrParty(missionId, actx, charId)

            case AwakeType.PARTY_OR_SPECIAL:
                if (charId === '1') return ctx.totalStories
                if (charId === '263002') return ctx.player.totalManaObtained ?? 0
                if (POWERFLIP_CHAR_IDS.has(missionId)) return actx.leaderPowerflips.get(charId) ?? 0
                return isLeaderRequired
                    ? actx.leaderClears.get(charId) ?? 0
                    : actx.charClears.get(charId) ?? 0

            case AwakeType.SPECIAL:
                if (charId === '1') return ctx.player.totalPowerflips ?? 0
                if (BOND_TOKEN_MISSION_IDS.has(missionId)) {
                    const char = actx.charData.get(charId)
                    return char?.bondTokenList.every(bt => bt.status >= 2) ? 1 : 0
                }
                if (COOP_MISSION_IDS.has(missionId)) {
                    return actx.leaderMultiClears.get(charId) ?? 0
                }
                if (COMBO_MISSION_IDS.has(missionId)) {
                    return ctx.player.maxComboAchieved ?? 0
                }
                return isLeaderRequired
                    ? actx.leaderClears.get(charId) ?? 0
                    : actx.charClears.get(charId) ?? 0

            case AwakeType.ALL_COMPLETE: {
                const s1 = AwakeComputer.compute(missionId - 3, ctx, dbProgress)
                const s2 = AwakeComputer.compute(missionId - 2, ctx, dbProgress)
                const s3 = AwakeComputer.compute(missionId - 1, ctx, dbProgress)
                return (s1 >= 1 ? 1 : 0) + (s2 >= 1 ? 1 : 0) + (s3 >= 1 ? 1 : 0)
            }
        }

        return dbProgress
    },
}

enum AwakeType {
    STORY_READ = 1,
    PARTY_OR_SPECIAL = 2,
    SPECIAL = 3,
    ALL_COMPLETE = 4,
}

function computeStoryOrParty(missionId: number, actx: AwakeContext, charId: string): number {
    if (STORY_MISSION_IDS.has(missionId)) {
        const storyIds = getCharacterStoryQuestIds(charId)
        let count = 0
        for (const qid of storyIds) {
            if (actx.questProgress['3']?.find(q => q.questId === qid)?.finished) count++
        }
        return count
    }
    return actx.charClears.get(charId) ?? 0
}
