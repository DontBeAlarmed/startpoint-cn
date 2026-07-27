import { Reward, ScoreReward } from "./rewards"

import { RushEventFolder } from "./rush"

export enum QuestCategory {
    EMPTY,
    MAIN, //
    BOSS_BATTLE, //
    CHARACTER, //
    EX, //
    EMPTY2,
    DAILY_WEEK_EVENT, //
    ADVENT_EVENT_SINGLE, //
    ADVENT_EVENT_MULTI, //
    TUTORIAL,
    STORY_EVENT_SINGLE, //?
    RANKING_EVENT_SINGLE, //?
    EMPTY3,
    CHALLENGE_DUNGEON_EVENT, //?
    DAILY_EXP_MANA_EVENT, //
    PRACTICE,
    SKILL_PREVIEW,
    EMPTY4,
    WORLD_STORY_EVENT, //
    WORLD_STORY_EVENT_BOSS_BATTLE, //
    TOWER_DUNGEON_EVENT, //?
    EXPERT_SINGLE_EVENT, //?
    CARNIVAL_EVENT, //?
    RAID_EVENT, //?
    RUSH_EVENT, //?
    SOLO_TIME_ATTACK_EVENT, //?
    HARD_MULTI_EVENT,
    SCORE_ATTACK_EVENT //?
}


export enum Element {
    FIRE,
    WATER,
    LIGHTNING,
    WIND,
    LIGHT,
    DARK
}


export interface RawQuest {
    name: string,
    enemyLevel?: number,
    clearRewardId?: number,
    sPlusRewardId?: number,
    scoreRewardGroupId?: number,
    commonRewardCount?: number,
    commonRewardCounts?: readonly [number, number, number, number, number],
    eventId?: number,
    folderId?: number,
    difficultyScore?: number,
    timeLimitMs?: number,
    killCountWeight?: number,
    bRankTime?: number,
    aRankTime?: number,
    sRankTime?: number,
    sPlusRankTime?: number,
    bRankScore?: number,
    aRankScore?: number,
    sRankScore?: number,
    ssRankScore?: number,
    scoreAttackQuestId?: number,
    rankPointReward?: number,
    characterExpReward?: number,
    manaReward?: number,
    poolExpReward?: number,
    fixedParty?: number,
    isBothBoss?: boolean,
    rushEventId?: number
    rushEventFolderId?: number
    rushEventRound?: number
    element?: number
}


export interface StoryQuest {
    name: string,
    clearReward?: Reward
}


export interface BattleQuest {
    name: string,
    enemyLevel: number,
    clearReward?: Reward,
    sPlusReward?: Reward,
    scoreRewardGroupId?: number,
    scoreRewardGroup?: ScoreReward[],
    commonRewardCount?: number,
    commonRewardCounts?: readonly [number, number, number, number, number],
    eventId?: number,
    folderId?: number,
    difficultyScore?: number,
    timeLimitMs?: number,
    killCountWeight?: number,
    bRankTime: number,
    aRankTime: number,
    sRankTime: number,
    sPlusRankTime: number,
    bRankScore?: number,
    aRankScore?: number,
    sRankScore?: number,
    ssRankScore?: number,
    scoreAttackQuestId?: number,
    rankPointReward: number,
    characterExpReward: number,
    manaReward: number,
    poolExpReward: number,
    fixedParty?: number,
    isBothBoss?: boolean,
    rushEventId?: number
    rushEventFolderId?: RushEventFolder
    rushEventRound?: number
    element?: number
}


export type RawQuests = Record<string, RawQuest>
