import adventEventQuests from "../../assets/advent_event_quest.json"
import bossBattleQuests from "../../assets/boss_battle_quest.json"
import hardMultiEventQuests from "../../assets/hard_multi_event_quest.json"
import raidEventQuests from "../../assets/raid_event_quest.json"
import worldStoryEventBossBattleQuests from "../../assets/world_story_event_boss_battle_quest.json"
import { QuestCategory, Reward, RewardType } from "../lib/types"

export const RESCUE_SILVER_FRAGMENT_ITEM_ID = 49000
export const RESCUE_GOLD_FRAGMENT_ITEM_ID = 49001
export const RESCUE_PURPLE_FRAGMENT_ITEM_ID = 49002

type RawBattleQuest = { rankPointReward?: number; [key: string]: unknown }
type RawQuestTable = Record<string, RawBattleQuest>
const rewardByQuest = new Map<string, number>()

function key(category: number, questId: number): string {
    const normalizedCategory = category === QuestCategory.ADVENT_EVENT_SINGLE
        ? QuestCategory.ADVENT_EVENT_MULTI
        : category
    return `${normalizedCategory}:${Math.abs(Math.trunc(questId))}`
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

export function resolveLocalRescueFragmentEligibility(input: {
    readonly allMultiRoomsEligible: boolean
    readonly isRoomHost: boolean
    readonly hostSelfRescueEnabled: boolean
}): boolean {
    return input.allMultiRoomsEligible
        && (!input.isRoomHost || input.hostSelfRescueEnabled)
}

export function settleRescueFragmentReward<TRewardResult>(
    input: {
        readonly eligible: boolean
        readonly questAccomplished: boolean
        readonly questCategory: number
        readonly questId: number
    },
    grant: (rewards: readonly Reward[]) => TRewardResult,
): TRewardResult | null {
    const eligible = input.eligible && input.questAccomplished
    const reward = eligible
        ? getRescueFragmentReward(input.questCategory, input.questId)
        : null
    return reward === null ? null : grant([reward])
}
