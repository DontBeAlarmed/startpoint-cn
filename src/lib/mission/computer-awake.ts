// Character awakening mission computer (category 9)

import { getPlayerCharacterClearsSync } from "../../data/domains/character_clear"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"
import { isMissionProgressComplete } from "./stages"
import type { MissionComputer, CategoryContext } from "./types"
import type { PlayerCharacter } from "../../data/types"
import {
    AWAKE_DIRECT_BATTLE_MISSION_IDS,
    getCharacterPairKey,
    isBondTokenMissionComplete,
    mergePartyCoClearRows,
} from "./awake-battle-rules"
import {
    getAwakeMissionIdsByFamily,
    isAwakeGenericCharacterClearMission,
} from "./awake-rule-catalog"
import { buildAwakeContextFromSession } from "./awake-session-context"

// ─── Awake-specific context (extends base) ───

export interface AwakeContext extends CategoryContext {
    charClears: Map<string, number>
    leaderClears: Map<string, number>
    multiClears: Map<string, number>
    leaderMultiClears: Map<string, number>
    coClears: Map<string, number>
    charData: Map<string, PlayerCharacter>
    categoryMissionProgress: Map<number, number>
}

// ─── Special mission tables ───

interface QuestClearTarget {
    category: number
    questIds: number[]
    timeLimitMs?: number
    leaderCharId?: number
}

const QUEST_CLEAR_MAP: Map<number, QuestClearTarget> = new Map([
    [1410032, { category: 2, questIds: [1020003] }],
])

const BOND_TOKEN_MISSION_IDS = new Set([1410033, 2210043, 2510043, 2610073])
const LEADER_REQUIRED_IDS = new Set([1610023])
const COOP_MISSION_IDS = new Set([1310053, 1510063])

// Multi-character party missions: mission_id → required character IDs (from col[24])
const MULTI_CHAR_MISSIONS: Map<number, number[]> = new Map([
    [2110012, [211001, 231001]],
    [2210042, [10, 221004]],
    [2410632, [241063, 243007]],
    [2510042, [251004, 1]],
])

// ─── Computer ───

function coClearKey(a: number, b: number): string {
    return getCharacterPairKey(a, b)
}

export function buildAwakeContext(
    playerId: number,
    allChars: Record<string, PlayerCharacter> = getPlayerCharactersSync(playerId),
): AwakeContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)
    const characterClears = getPlayerCharacterClearsSync(playerId)

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
                if (qp.clearRank === 5) ssClears++
                else if (qp.clearRank === 4) sClears++
                else if (qp.clearRank === 3) aClears++
                else if (qp.clearRank === 2) bClears++
            }
        }
        questProgress[section] = list
    }

    const charClears = new Map<string, number>()
    const leaderClears = new Map<string, number>()
    const multiClears = new Map<string, number>()
    const leaderMultiClears = new Map<string, number>()
    const charData = new Map<string, PlayerCharacter>()
    for (const [cid, char] of Object.entries(allChars)) {
        charData.set(cid, char)
        const row = characterClears[cid] ?? {
            clear_count: 0,
            multi_count: 0,
            leader_clear_count: 0,
            leader_multi_count: 0,
            leader_power_flip_count: 0,
        }
        charClears.set(cid, row.clear_count)
        leaderClears.set(cid, row.leader_clear_count)
        multiClears.set(cid, row.multi_count)
        leaderMultiClears.set(cid, row.leader_multi_count)
    }

    // Pre-fetch co-clear counts for multi-char missions
    const rows = getDb().prepare(`
    SELECT char_id_a, char_id_b, co_clear_count FROM players_party_member_co_clears
    WHERE player_id = ?
    `).all(playerId) as { char_id_a: number; char_id_b: number; co_clear_count: number }[]
    const coClears = mergePartyCoClearRows(rows)

    const categoryMissionProgress = new Map<number, number>()
    for (const [missionId, progress] of Object.entries(getPlayerCategoryMissionsSync(playerId, 9))) {
        categoryMissionProgress.set(Number(missionId), progress.progress)
    }

    return {
        category: 9,
        playerId, player, questProgress,
        totalQuestClears, totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
        charClears, leaderClears, multiClears, leaderMultiClears,
        coClears, charData, categoryMissionProgress,
    }
}

export const AwakeComputer: MissionComputer = {
    name: "Awake",

    buildContext(playerId: number, _category: number): AwakeContext {
        return buildAwakeContext(playerId)
    },

    buildContextFromSession: buildAwakeContextFromSession,

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const computed = computeAwakeDerivedProgress(missionId, ctx as AwakeContext, dbProgress)
        return Math.max(dbProgress, Number.isFinite(computed) ? computed : 0)
    },
}

function computeAwakeDerivedProgress(
    missionId: number,
    actx: AwakeContext,
    dbProgress: number,
): number {
    const charId = getCharacterIdFromMission(missionId)

    const qc = QUEST_CLEAR_MAP.get(missionId)
    if (qc) {
        const progress = actx.questProgress[String(qc.category)]
        if (!progress) return 0
        const matches = progress.filter(q => qc.questIds.includes(q.questId) && q.finished)
        if (matches.length === 0) return 0
        const timeLimitMs = qc.timeLimitMs
        if (timeLimitMs !== undefined
            && !matches.some(q => (q.bestElapsedTimeMs ?? Infinity) <= timeLimitMs)) return 0
        if (qc.leaderCharId
            && !matches.some(q => q.leaderCharacterId === qc.leaderCharId)) return 0
        return 1
    }

    // Per-finish atomic facts and unresolved families both read persisted progress.
    if (AWAKE_DIRECT_BATTLE_MISSION_IDS.has(missionId)) {
        return actx.categoryMissionProgress?.get(missionId) ?? dbProgress
    }

    // Two-character co-clear missions can use their pairwise same-battle counter.
    const reqChars = MULTI_CHAR_MISSIONS.get(missionId)
    if (reqChars) {
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
    switch (missionId % 10) {
        case AwakeType.STORY_READ:
            return computeStoryOrParty(missionId, actx, charId, dbProgress)

        case AwakeType.PARTY_OR_SPECIAL:
            if (charId === '1') return actx.totalStories
            if (charId === '263002') return actx.player.totalManaObtained ?? 0
            if (!isAwakeGenericCharacterClearMission(missionId)
                && !isLeaderRequired) return 0
            return isLeaderRequired
                ? actx.leaderClears.get(charId) ?? 0
                : actx.charClears.get(charId) ?? 0

        case AwakeType.SPECIAL:
            if (BOND_TOKEN_MISSION_IDS.has(missionId)) {
                const char = actx.charData.get(charId)
                return isBondTokenMissionComplete(char?.bondTokenList) ? 1 : 0
            }
            if (COOP_MISSION_IDS.has(missionId)) {
                return actx.leaderMultiClears.get(charId) ?? 0
            }
            if (!isAwakeGenericCharacterClearMission(missionId)
                && !isLeaderRequired) return 0
            return isLeaderRequired
                ? actx.leaderClears.get(charId) ?? 0
                : actx.charClears.get(charId) ?? 0

        case AwakeType.ALL_COMPLETE: {
            let completedCount = 0
            for (const childMissionId of [missionId - 3, missionId - 2, missionId - 1]) {
                const childDbProgress = actx.categoryMissionProgress?.get(childMissionId) ?? 0
                const childProgress = AwakeComputer.compute(childMissionId, actx, childDbProgress)
                if (isMissionProgressComplete(9, childMissionId, childProgress)) completedCount++
            }
            return completedCount
        }
    }

    return 0
}

enum AwakeType {
    STORY_READ = 1,
    PARTY_OR_SPECIAL = 2,
    SPECIAL = 3,
    ALL_COMPLETE = 4,
}

function computeStoryOrParty(
    missionId: number,
    actx: AwakeContext,
    charId: string,
    dbProgress: number,
): number {
    if (getAwakeMissionIdsByFamily("story-read").includes(missionId)) {
        const storyIds = getCharacterStoryQuestIds(charId)
        let count = 0
        for (const qid of storyIds) {
            if (actx.questProgress['3']?.find(q => q.questId === qid)?.finished) count++
        }
        return count
    }
    if (!isAwakeGenericCharacterClearMission(missionId)) {
        return actx.categoryMissionProgress?.get(missionId) ?? dbProgress
    }
    return actx.charClears.get(charId) ?? 0
}
