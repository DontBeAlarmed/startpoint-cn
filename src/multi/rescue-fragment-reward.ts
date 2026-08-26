import adventEventQuests from "../../assets/advent_event_quest.json"
import bossBattleQuests from "../../assets/boss_battle_quest.json"
import hardMultiEventQuests from "../../assets/hard_multi_event_quest.json"
import raidEventQuests from "../../assets/raid_event_quest.json"
import worldStoryEventBossBattleQuests from "../../assets/world_story_event_boss_battle_quest.json"
import { QuestCategory, Reward, RewardType } from "../lib/types"

export const RESCUE_SILVER_FRAGMENT_ITEM_ID = 49000
export const RESCUE_GOLD_FRAGMENT_ITEM_ID = 49001
export const RESCUE_PURPLE_FRAGMENT_ITEM_ID = 49002
export const RESCUE_SILVER_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID = 490000
export const RESCUE_GOLD_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID = 490001
export const RESCUE_PURPLE_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID = 490002

export interface RescueFragmentAdditionalReward {
    group_id: number
    index: number
    number: number
}

type RawBattleQuest = { rankPointReward?: number; [key: string]: unknown }
type RawQuestTable = Record<string, RawBattleQuest>
const rewardByQuest = new Map<string, number>()

function key(category: number, questId: number): string {
    return `${category}:${Math.abs(Math.trunc(questId))}`
}

function register(category: number, questId: number, itemId: number): void {
    rewardByQuest.set(key(category, questId), itemId)
}

function groupedQuestIds(table: RawQuestTable): number[][] {
    const groups = new Map<number, number[]>()
    for (const [rawId, quest] of Object.entries(table)) {
        const questId = Number(rawId)
        if (!Number.isSafeInteger(questId) || quest.rankPointReward === undefined) continue
        const groupId = Math.floor(questId / 1000)
        const group = groups.get(groupId) ?? []
        group.push(questId)
        groups.set(groupId, group)
    }
    return [...groups.values()].map(group => group.sort((left, right) => left - right))
}

function registerSequential(category: number, table: RawQuestTable): void {
    for (const questIds of groupedQuestIds(table)) {
        questIds.forEach((questId, index) => {
            const itemId = questIds.length <= 2
                ? (index === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID : RESCUE_GOLD_FRAGMENT_ITEM_ID)
                : questIds.length === 3
                    ? (index === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                        : index === 1 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID)
                    : index <= 1 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                        : index === 2 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID
            register(category, questId, itemId)
        })
    }
}

for (const questIds of groupedQuestIds(bossBattleQuests)) {
    const bossId = Math.floor(questIds[0] / 1000)
    for (const questId of questIds) {
        const difficulty = questId % 1000
        const itemId = bossId === 1001
            ? (difficulty === 1 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                : difficulty === 2 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID)
            : bossId === 1020
                ? (difficulty === 1 ? RESCUE_SILVER_FRAGMENT_ITEM_ID : RESCUE_GOLD_FRAGMENT_ITEM_ID)
                : difficulty <= 2 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                    : difficulty === 3 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID
        register(QuestCategory.BOSS_BATTLE, questId, itemId)
    }
}

registerSequential(QuestCategory.ADVENT_EVENT_MULTI, adventEventQuests)
for (const questIds of groupedQuestIds(worldStoryEventBossBattleQuests)) {
    questIds.forEach((questId, index) => register(
        QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
        questId,
        index % 2 === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID : RESCUE_GOLD_FRAGMENT_ITEM_ID,
    ))
}
for (const [rawId, quest] of Object.entries(raidEventQuests)) {
    const questId = Number(rawId)
    if (!Number.isSafeInteger(questId) || quest.rankPointReward === undefined) continue
    register(
        QuestCategory.RAID_EVENT,
        questId,
        quest.rankPointReward <= 50 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
            : quest.rankPointReward < 100 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    )
}
for (const rawId of Object.keys(hardMultiEventQuests)) {
    const questId = Number(rawId)
    if (Number.isSafeInteger(questId)) register(
        QuestCategory.HARD_MULTI_EVENT,
        questId,
        RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    )
}

export function getRescueFragmentReward(category: number, questId: number): Reward | null {
    const itemId = rewardByQuest.get(key(category, questId))
    return itemId === undefined ? null : { type: RewardType.ITEM, id: itemId, count: 10 } as Reward
}

export function getRescueFragmentAdditionalReward(
    reward: Reward | null,
): RescueFragmentAdditionalReward | null {
    if (reward === null || reward.type !== RewardType.ITEM || reward.id === undefined) return null
    const groupId = reward.id === RESCUE_SILVER_FRAGMENT_ITEM_ID
        ? RESCUE_SILVER_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID
        : reward.id === RESCUE_GOLD_FRAGMENT_ITEM_ID
            ? RESCUE_GOLD_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID
            : reward.id === RESCUE_PURPLE_FRAGMENT_ITEM_ID
                ? RESCUE_PURPLE_FRAGMENT_ADDITIONAL_REWARD_GROUP_ID : null
    return groupId === null ? null : { group_id: groupId, index: 1, number: 10 }
}

export interface RescueFragmentSettlement<TRewardResult> {
    readonly rewardResult: TRewardResult | null
    readonly additionalReward: RescueFragmentAdditionalReward | null
}

export function settleRescueFragmentReward<TRewardResult>(
    input: {
        readonly enabled: boolean
        readonly questAccomplished: boolean
        readonly questCategory: number
        readonly questId: number
    },
    grant: (rewards: readonly Reward[]) => TRewardResult,
): RescueFragmentSettlement<TRewardResult> {
    const reward = input.enabled && input.questAccomplished
        ? getRescueFragmentReward(input.questCategory, input.questId)
        : null
    if (reward === null) return { rewardResult: null, additionalReward: null }
    return {
        rewardResult: grant([reward]),
        additionalReward: getRescueFragmentAdditionalReward(reward),
    }
}
