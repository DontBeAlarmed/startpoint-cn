import practiceQuests from "../../assets/practice_quest.json";
import { BattleQuest, ClearRewards, QuestCategory, RareScoreReward, RareScoreRewardGroups, RawQuests, Reward, ScoreReward, ScoreRewardGroups } from "./types";
import {
    getContentSnapshot,
} from "../content/runtime/content-snapshot";
import type { QuestTableName } from "../content/converters/quest";

export class QuestConfigurationError extends Error {
    constructor(
        public readonly category: QuestCategory,
        public readonly questId: string | number,
        public readonly rewardId: string | number,
        public readonly field: "clearRewardId" | "sPlusRewardId",
    ) {
        super(`Invalid quest reward configuration: category=${category} questId=${questId} rewardId=${rewardId} field=${field}`)
        this.name = "QuestConfigurationError"
    }
}

export function getQuestContentTableSync(tableName: QuestTableName): RawQuests {
    return getContentSnapshot().repository.table<RawQuests>(tableName)
}

/** Derived admin quest lookup ("category_questId" → display name). */
export function getQuestLookup(): Readonly<Record<string, string>> {
    return getContentSnapshot().repository.table<Readonly<Record<string, string>>>(
        "quest_lookup.json",
    )
}

/** Main quest ids belonging to one progression chapter (id / 1_000_000). */
export function getMainQuestIdsForChapter(chapter: number): readonly number[] {
    return Object.keys(getQuestContentTableSync("main_quest.json"))
        .map(Number)
        .filter(id => Math.floor(id / 1_000_000) === chapter)
}

export function getQuestConfigurationErrorResponse(error: unknown): Record<string, unknown> | null {
    if (!(error instanceof QuestConfigurationError)) return null
    return {
        error: "Internal Server Error",
        message: "Quest reward configuration is invalid.",
        category: error.category,
        quest_id: Number(error.questId),
        reward_id: Number(error.rewardId),
        field: error.field,
    }
}

/**
 * Gets a clear reward from its ID.
 *
 * @param clearRewardId The ID of the clear reward.
 * @returns The clear reward that was found, or null.
 */
export function getClearRewardSync(
    clearRewardId: string | number
): Reward | null {
    const clearReward = getContentSnapshot().repository.table<ClearRewards>(
        "clear_reward.json",
    )[String(clearRewardId)]
    return clearReward ? clearReward as Reward : null
}

/**
 * Gets a rare score reward group from its ID.
 *
 * @param groupId The ID of the rare score reward group.
 * @returns The score reward group that was found, or null.
 */
export function getRareScoreRewardGroup(
    groupId: string | number
): RareScoreReward[] | null {
    const group = getContentSnapshot().repository.table<RareScoreRewardGroups>(
        "rare_score_reward.json",
    )[String(groupId)]
    return group ? group as RareScoreReward[] : null
}

/**
 * Gets a score reward group from its ID.
 *
 * @param groupId The ID of the group.
 * @returns The score reward group that was found, or null.
 */
export function getScoreRewardGroup(
    groupId: string | number
): ScoreReward[] | null {
    const group = getContentSnapshot().repository.table<ScoreRewardGroups>(
        "score_reward.json",
    )[String(groupId)]
    return group ? group as ScoreReward[] : null
}

function getConfiguredQuestRewardSync(
    category: QuestCategory,
    questId: string | number,
    rewardId: string | number | undefined,
    field: "clearRewardId" | "sPlusRewardId",
): Reward | undefined {
    if (rewardId === undefined) return undefined

    const reward = getClearRewardSync(rewardId)
    if (reward === null) throw new QuestConfigurationError(category, questId, rewardId, field)
    return reward
}

/**
 * Generic quest fetching function.
 *
 * @param quests The list of quests to search.
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest, StoryQuest, or null
 */
function getQuestSync(
    quests: RawQuests,
    questId: string | number,
    category: QuestCategory,
): BattleQuest | null {
    const quest = quests[String(questId)]

    // return null if the quest doesn't exist
    if (!quest) return null;

    const clearReward = getConfiguredQuestRewardSync(category, questId, quest.clearRewardId, "clearRewardId")
    const sPlusReward = getConfiguredQuestRewardSync(category, questId, quest.sPlusRewardId, "sPlusRewardId")

    // always return BattleQuest; missing fields default to 0
    return {
        name: quest.name,
        ...(Object.prototype.hasOwnProperty.call(quest, "availableFromMs")
            ? { availableFromMs: quest.availableFromMs ?? null }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(quest, "availableUntilMs")
            ? { availableUntilMs: quest.availableUntilMs ?? null }
            : {}),
        enemyLevel: quest.enemyLevel ?? 0,
        clearReward,
        sPlusReward,
        scoreRewardGroupId: quest.scoreRewardGroupId ?? undefined,
        scoreRewardGroup: quest.scoreRewardGroupId != null ? getScoreRewardGroup(quest.scoreRewardGroupId) ?? undefined : undefined,
        commonRewardCount: quest.commonRewardCount,
        commonRewardCounts: quest.commonRewardCounts,
        element: quest.element,
        eventId: quest.eventId,
        folderId: quest.folderId,
        difficultyScore: quest.difficultyScore,
        timeLimitMs: quest.timeLimitMs,
        killCountWeight: quest.killCountWeight,
        bRankTime: quest.bRankTime ?? 0,
        aRankTime: quest.aRankTime ?? 0,
        sRankTime: quest.sRankTime ?? 0,
        sPlusRankTime: quest.sPlusRankTime ?? 0,
        bRankScore: quest.bRankScore,
        aRankScore: quest.aRankScore,
        sRankScore: quest.sRankScore,
        ssRankScore: quest.ssRankScore,
        scoreAttackQuestId: quest.scoreAttackQuestId,
        rankPointReward: quest.rankPointReward ?? 0,
        characterExpReward: quest.characterExpReward ?? 0,
        manaReward: quest.manaReward ?? 0,
        poolExpReward: quest.poolExpReward ?? 0,
        fixedParty: quest.fixedParty,
        isBothBoss: quest.isBothBoss,
        rushEventId: quest.rushEventId,
        rushEventFolderId: quest.rushEventFolderId,
        rushEventRound: quest.rushEventRound
    }
}

/**
 * Gets the data for a main quest from the database.
 *
 * @param questId The ID of the quest.
 * @returns A BattleQuest, StoryQuest, or null
 */
export function getMainQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("main_quest.json"), questId, QuestCategory.MAIN)
}

/**
 * Gets an EX quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getExQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("ex_quest.json"), questId, QuestCategory.EX)
}

/**
 * Gets a practice quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getPracticeQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync((practiceQuests as RawQuests), questId, QuestCategory.PRACTICE)
}

/**
 * Gets a boss battle quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getBossBattleQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("boss_battle_quest.json"), questId, QuestCategory.BOSS_BATTLE)
}

/**
 * Gets a character quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getCharacterQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("character_quest.json"), questId, QuestCategory.CHARACTER)
}

/**
 * Gets a world story event quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getWorldStoryEventQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("world_story_event_quest.json"), questId, QuestCategory.WORLD_STORY_EVENT)
}

/**
 * Gets a world story event boss battle quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getWorldStoryEventBossBattleQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("world_story_event_boss_battle_quest.json"), questId, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE)
}

/**
 * Gets an advent quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getAdventEventQuest(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("advent_event_quest.json"), questId, QuestCategory.ADVENT_EVENT_SINGLE)
}

/**
 * Gets a hard multi event quest.
 *
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getHardMultiEventQuest(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("hard_multi_event_quest.json"), questId, QuestCategory.HARD_MULTI_EVENT)
}

/**
 * Gets a quest from a specific quest category.
 *
 * @param category The category of the quest.
 * @param questId The ID of the quest.
 * @returns The BattleQuest or StoryQuest that was found, or null if nothing was found.
 */
export function getQuestFromCategorySync(
    category: QuestCategory,
    questId: string | number
): BattleQuest | null {
    switch (category) {
        case QuestCategory.MAIN:
            return getQuestSync(getQuestContentTableSync("main_quest.json"), questId, category)
        case QuestCategory.EX:
            return getQuestSync(getQuestContentTableSync("ex_quest.json"), questId, category)
        case QuestCategory.BOSS_BATTLE:
            return getQuestSync(getQuestContentTableSync("boss_battle_quest.json"), questId, category)
        case QuestCategory.CHARACTER:
            return getQuestSync(getQuestContentTableSync("character_quest.json"), questId, category)
        case QuestCategory.WORLD_STORY_EVENT:
            return getQuestSync(getQuestContentTableSync("world_story_event_quest.json"), questId, category)
        case QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE:
            return getQuestSync(getQuestContentTableSync("world_story_event_boss_battle_quest.json"), questId, category)
        case QuestCategory.ADVENT_EVENT_SINGLE:
        case QuestCategory.ADVENT_EVENT_MULTI:
            return getQuestSync(getQuestContentTableSync("advent_event_quest.json"), questId, category)
        case QuestCategory.STORY_EVENT_SINGLE:
            return getQuestSync(getQuestContentTableSync("story_event_single_quest.json"), questId, category)
        case QuestCategory.RANKING_EVENT_SINGLE:
            return getQuestSync(getQuestContentTableSync("ranking_event_single_quest.json"), questId, category)
        case QuestCategory.CHALLENGE_DUNGEON_EVENT:
            return getQuestSync(getQuestContentTableSync("challenge_dungeon_event_quest.json"), questId, category)
        case QuestCategory.DAILY_EXP_MANA_EVENT:
            return getQuestSync(getQuestContentTableSync("daily_exp_mana_event_quest.json"), questId, category)
        case QuestCategory.PRACTICE:
            return getQuestSync((practiceQuests as RawQuests), questId, category)
        case QuestCategory.DAILY_WEEK_EVENT:
            return getQuestSync(getQuestContentTableSync("daily_week_event_quest.json"), questId, category)
        case QuestCategory.TOWER_DUNGEON_EVENT:
            return getQuestSync(getQuestContentTableSync("tower_dungeon_event_quest.json"), questId, category)
        case QuestCategory.EXPERT_SINGLE_EVENT:
            return getQuestSync(getQuestContentTableSync("expert_single_event_quest.json"), questId, category)
        case QuestCategory.CARNIVAL_EVENT:
            return getQuestSync(getQuestContentTableSync("carnival_event_quest.json"), questId, category)
        case QuestCategory.RAID_EVENT:
            return getQuestSync(getQuestContentTableSync("raid_event_quest.json"), questId, category)
        case QuestCategory.RUSH_EVENT:
            return getQuestSync(getQuestContentTableSync("rush_event_quest.json"), questId, category)
        case QuestCategory.SOLO_TIME_ATTACK_EVENT:
            return getQuestSync(getQuestContentTableSync("solo_time_attack_event_quest.json"), questId, category)
        case QuestCategory.SCORE_ATTACK_EVENT:
            return getQuestSync(getQuestContentTableSync("score_attack_event_quest.json"), questId, category)
        case QuestCategory.HARD_MULTI_EVENT:
            return getQuestSync(getQuestContentTableSync("hard_multi_event_quest.json"), questId, category)
        default:
            return null
    }
}
