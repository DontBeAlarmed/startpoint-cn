import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import { QuestCategory } from "./types"

export const RESCUE_SILVER_FRAGMENT_ITEM_ID = 49000
export const RESCUE_GOLD_FRAGMENT_ITEM_ID = 49001
export const RESCUE_PURPLE_FRAGMENT_ITEM_ID = 49002

type RawBattleQuest = { rankPointReward?: number; [key: string]: unknown }
type RawQuestTable = Record<string, RawBattleQuest>

export interface RescueFragmentContent {
    readonly getItemId: (category: number, questId: number) => number | null
}

function key(category: number, questId: number): string {
    return `${category}:${Math.abs(Math.trunc(questId))}`
}

function canonicalCategory(category: number): number {
    return category === QuestCategory.ADVENT_EVENT_SINGLE
        ? QuestCategory.ADVENT_EVENT_MULTI
        : category
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

function buildRescueMap(
    category: number,
    table: RawQuestTable,
): ReadonlyMap<string, number> {
    const rewardByQuest = new Map<string, number>()
    const register = (questId: number, itemId: number): void => {
        rewardByQuest.set(key(category, questId), itemId)
    }
    const registerSequential = (): void => {
        for (const questIds of groupedQuestIds(table)) {
            questIds.forEach((questId, index) => {
                const itemId = questIds.length <= 2
                    ? (index === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID : RESCUE_GOLD_FRAGMENT_ITEM_ID)
                    : questIds.length === 3
                        ? (index === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                            : index === 1 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID)
                        : index <= 1 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                            : index === 2 ? RESCUE_GOLD_FRAGMENT_ITEM_ID : RESCUE_PURPLE_FRAGMENT_ITEM_ID
                register(questId, itemId)
            })
        }
    }

    if (category === QuestCategory.BOSS_BATTLE) {
        for (const questIds of groupedQuestIds(table)) {
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
                register(questId, itemId)
            }
        }
    } else if (category === QuestCategory.ADVENT_EVENT_MULTI) {
        registerSequential()
    } else if (category === QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE) {
        for (const questIds of groupedQuestIds(table)) {
            questIds.forEach((questId, index) => register(
                questId,
                index % 2 === 0 ? RESCUE_SILVER_FRAGMENT_ITEM_ID : RESCUE_GOLD_FRAGMENT_ITEM_ID,
            ))
        }
    } else if (category === QuestCategory.RAID_EVENT) {
        for (const [rawId, quest] of Object.entries(table)) {
            const questId = Number(rawId)
            if (!Number.isSafeInteger(questId) || quest.rankPointReward === undefined) continue
            register(
                questId,
                quest.rankPointReward <= 50 ? RESCUE_SILVER_FRAGMENT_ITEM_ID
                    : quest.rankPointReward < 100 ? RESCUE_GOLD_FRAGMENT_ITEM_ID
                        : RESCUE_PURPLE_FRAGMENT_ITEM_ID,
            )
        }
    } else if (category === QuestCategory.HARD_MULTI_EVENT) {
        for (const rawId of Object.keys(table)) {
            const questId = Number(rawId)
            if (Number.isSafeInteger(questId)) register(questId, RESCUE_PURPLE_FRAGMENT_ITEM_ID)
        }
    }
    return rewardByQuest
}

const TABLE_BY_CATEGORY: Readonly<Record<number, string>> = Object.freeze({
    [QuestCategory.BOSS_BATTLE]: "boss_battle_quest.json",
    [QuestCategory.ADVENT_EVENT_MULTI]: "advent_event_quest.json",
    [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE]: "world_story_event_boss_battle_quest.json",
    [QuestCategory.RAID_EVENT]: "raid_event_quest.json",
    [QuestCategory.HARD_MULTI_EVENT]: "hard_multi_event_quest.json",
})

const contentByRepository = new WeakMap<ReadonlyContentRepository, RescueFragmentContent>()

export function getRescueFragmentContent(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): RescueFragmentContent {
    const cached = contentByRepository.get(repository)
    if (cached !== undefined) return cached

    const mapsByCategory = new Map<number, ReadonlyMap<string, number>>()
    const content = Object.freeze({
        getItemId: (category: number, questId: number): number | null => {
            const normalizedCategory = canonicalCategory(category)
            const tableName = TABLE_BY_CATEGORY[normalizedCategory]
            if (tableName === undefined) return null
            let rewardByQuest = mapsByCategory.get(normalizedCategory)
            if (rewardByQuest === undefined) {
                rewardByQuest = buildRescueMap(
                    normalizedCategory,
                    repository.table<RawQuestTable>(tableName),
                )
                mapsByCategory.set(normalizedCategory, rewardByQuest)
            }
            return rewardByQuest.get(key(normalizedCategory, questId)) ?? null
        },
    })
    contentByRepository.set(repository, content)
    return content
}
