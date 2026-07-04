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
    clearRewardId?: number,
    sPlusRewardId?: number,
    scoreRewardGroupId?: number,
    eventId?: number,
    folderId?: number,
    bRankTime?: number,
    aRankTime?: number,
    sRankTime?: number,
    sPlusRankTime?: number,
    rankPointReward?: number,
    characterExpReward?: number,
    manaReward?: number,
    poolExpReward?: number,
    fixedParty?: number,
    rushEventId?: number
    rushEventFolderId?: number
    rushEventRound?: number
    element?: number
    viewableNeedQuest?: QuestReference | null
    selectableNeedQuest?: QuestReference | null
}


export interface QuestReference {
    kind: number | null
    id: number | null
    category?: number | null
    values?: Array<number | null>
}


export interface StoryQuest {
    name: string,
    clearReward?: Reward
    eventId?: number
    viewableNeedQuest?: QuestReference | null
    viewableNeedQuests?: QuestReference[]
    selectableNeedQuest?: QuestReference | null
    selectableNeedQuests?: QuestReference[]
}


export interface RankItemCounts {
    c: number
    b: number
    a: number
    s: number
    ss: number
}


export interface BattleQuest {
    name: string,
    clearReward?: Reward,
    sPlusReward?: Reward,
    scoreRewardGroupId?: number,
    scoreRewardGroup?: ScoreReward[],
    eventId?: number,
    folderId?: number,
    bRankTime: number,
    aRankTime: number,
    sRankTime: number,
    sPlusRankTime: number,
    rankPointReward: number,
    characterExpReward: number,
    manaReward: number,
    poolExpReward: number,
    fixedParty?: number,
    rushEventId?: number
    rushEventFolderId?: RushEventFolder
    rushEventRound?: number
    element?: number
    staminaCost?: number
    availablePlayKind?: number | null
    startableUseItemMode?: number | null
    startableItemIds?: number[]
    startableItemCounts?: number[]
    maxContinueCount?: number | null
    rankItemCounts?: RankItemCounts
    viewableNeedQuest?: QuestReference | null
    viewableNeedQuests?: QuestReference[]
    selectableNeedQuest?: QuestReference | null
    selectableNeedQuests?: QuestReference[]
}


export type RawQuests = Record<string, RawQuest>
