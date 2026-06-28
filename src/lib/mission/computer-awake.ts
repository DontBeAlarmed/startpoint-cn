// Character awakening mission computer (category 9)

import { getPlayerSync, getPlayerQuestProgressSync, getPlayerCharacterSync, getPlayerCharactersSync, getPlayerCharacterClearSync } from "../../data/wdfpData"
import { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"
import type { MissionComputer, CategoryContext } from "./types"
import type { PlayerCharacter } from "../../data/types"

// ─── Awake-specific context (extends base) ───

interface AwakeContext extends CategoryContext {
    charClears: Map<string, number>
    leaderClears: Map<string, number>
    charData: Map<string, PlayerCharacter>
}

// ─── Special mission tables ───

interface QuestClearTarget {
    category: number
    questIds: number[]
}

const QUEST_CLEAR_MAP: Map<number, QuestClearTarget> = new Map([
    [1110013, { category: 2, questIds: [1028004] }],
    [1310052, { category: 15, questIds: [96] }],
    [1410032, { category: 2, questIds: [1020003] }],
    [2110013, { category: 2, questIds: [1028004] }],
    [2510032, { category: 13, questIds: [1020, 1023, 1026, 1029, 1032, 1035, 1038] }],
    [2630023, { category: 19, questIds: [100100004, 100401004] }],
])

const BOND_TOKEN_MISSION_IDS = new Set([1410033, 2210043, 2510043, 2610073])

/** Missions that require the character as party LEADER (not just a member) */
const LEADER_REQUIRED_IDS = new Set([1510062, 1610022, 1610023, 2310012, 2610072])

// ─── Computer ───

function buildAwakeContext(playerId: number): AwakeContext {
    const player = getPlayerSync(playerId)!
    const questProgressRaw = getPlayerQuestProgressSync(playerId)
    const allChars = getPlayerCharactersSync(playerId)

    let totalQuestClears = 0, ssClears = 0, sClears = 0, aClears = 0, bClears = 0, totalStories = 0
    const questProgress: CategoryContext["questProgress"] = {}

    for (const [section, quests] of Object.entries(questProgressRaw)) {
        const list: CategoryContext["questProgress"][string] = []
        for (const qp of quests) {
            list.push({ questId: qp.questId, finished: qp.finished, clearRank: qp.clearRank })
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

    // Pre-fetch character clear counts (batch: one DB call per owned character)
    const charClears = new Map<string, number>()
    const leaderClears = new Map<string, number>()
    const charData = new Map<string, PlayerCharacter>()
    for (const [cid, char] of Object.entries(allChars)) {
        charData.set(cid, char)
        const row = getPlayerCharacterClearSync(playerId, Number(cid))
        charClears.set(cid, row.clear_count)
        leaderClears.set(cid, row.leader_clear_count)
    }

    return {
        playerId,
        player,
        questProgress,
        totalQuestClears,
        totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
        charClears,
        leaderClears,
        charData,
    }
}

export const AwakeComputer: MissionComputer = {
    name: "Awake",

    buildContext(playerId: number): AwakeContext {
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
            return progress.some(q => qc.questIds.includes(q.questId) && q.finished) ? 1 : 0
        }

        // Leader-required missions: use leader_clear_count
        const isLeaderRequired = LEADER_REQUIRED_IDS.has(missionId)

        // Dispatch by lastDigit
        switch (lastDigit) {
            case AwakeType.STORY_READ:
                return computeStoryOrParty(missionId, actx, charId)

            case AwakeType.PARTY_OR_SPECIAL:
                if (charId === '1') return ctx.totalStories
                if (charId === '263002') return ctx.player.totalManaObtained ?? 0
                return isLeaderRequired
                    ? actx.leaderClears.get(charId) ?? 0
                    : actx.charClears.get(charId) ?? 0

            case AwakeType.SPECIAL:
                if (charId === '1') return ctx.player.totalPowerflips ?? 0
                if (BOND_TOKEN_MISSION_IDS.has(missionId)) {
                    const char = actx.charData.get(charId)
                    return char?.bondTokenList.every(bt => bt.status >= 2) ? 1 : 0
                }
                return isLeaderRequired
                    ? actx.leaderClears.get(charId) ?? 0
                    : actx.charClears.get(charId) ?? 0

            case AwakeType.ALL_COMPLETE: {
                const s1 = AwakeComputer.compute(missionId - 3, ctx, dbProgress)
                const s2 = AwakeComputer.compute(missionId - 2, ctx, dbProgress)
                const s3 = AwakeComputer.compute(missionId - 1, ctx, dbProgress)
                return (s1 >= 1 && s2 >= 1 && s3 >= 1) ? 1 : 0
            }
        }

        return dbProgress
    },
}

// ─── Awake type enum (self-documenting) ───

enum AwakeType {
    STORY_READ = 1,
    PARTY_OR_SPECIAL = 2,
    SPECIAL = 3,
    ALL_COMPLETE = 4,
}

// ─── Pure compute helpers (no DB, no side effects) ───

function computeStoryOrParty(_missionId: number, actx: AwakeContext, charId: string): number {
    const storyIds = getCharacterStoryQuestIds(charId)
    if (storyIds.length === 0) {
        return actx.charClears.get(charId) ?? 0
    }
    let count = 0
    for (const qid of storyIds) {
        if (actx.questProgress['3']?.find(q => q.questId === qid)?.finished) count++
    }
    return count
}
