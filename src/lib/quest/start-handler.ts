import { QuestCategory } from "../types"
import type { BattleQuest, QuestReference } from "../types"

export interface BattleStartEntryCost {
    itemId: number
    itemCount: number
    stamina: number
}

interface QuestStartPrerequisites {
    viewableNeedQuest?: QuestReference | null
    viewableNeedQuests?: QuestReference[]
    selectableNeedQuest?: QuestReference | null
    selectableNeedQuests?: QuestReference[]
}

interface QuestProgressForStart {
    finished?: boolean | null
}

export function resolveBattleStartEntryCost(
    quest: BattleQuest,
    fallback?: BattleStartEntryCost,
): BattleStartEntryCost | undefined {
    const itemId = quest.startableItemIds?.[0]
    const itemCount = quest.startableItemCounts?.[0]
    if (itemId !== undefined && itemId > 0 && itemCount !== undefined && itemCount > 0) {
        return {
            itemId,
            itemCount,
            stamina: fallback?.stamina ?? quest.staminaCost ?? 0
        }
    }

    return fallback
}

export function resolveBattleStartStaminaCost(
    quest: BattleQuest,
    staminaInfo: { baseCost: number; cost: number; rate: number },
): number {
    if (staminaInfo.baseCost > 0) return staminaInfo.cost
    return quest.staminaCost ?? 0
}

export function canContinueBattle(
    quest: BattleQuest,
    currentContinueCount: number,
): { ok: true } | { ok: false, message: string } {
    if (quest.maxContinueCount === null || quest.maxContinueCount === undefined) return { ok: true }
    if (quest.maxContinueCount <= 0) return { ok: false, message: "Quest cannot be continued." }
    if (currentContinueCount >= quest.maxContinueCount) return { ok: false, message: "Maximum continue count reached." }
    return { ok: true }
}

function collectQuestPrerequisiteIds(quest: QuestStartPrerequisites): number[] {
    const references = [
        ...(quest.viewableNeedQuests ?? []),
        ...(quest.selectableNeedQuests ?? []),
    ]

    if (references.length === 0) {
        if (quest.viewableNeedQuest) references.push(quest.viewableNeedQuest)
        if (quest.selectableNeedQuest) references.push(quest.selectableNeedQuest)
    }

    return [...new Set(references
        .map((reference) => reference.id)
        .filter((id): id is number => id !== null && id !== undefined && id > 0))]
}

export function canStartQuestByPrerequisites(
    quest: QuestStartPrerequisites,
    hasClearedQuest: (questId: number) => boolean,
): { ok: true } | { ok: false, message: string } {
    for (const requiredQuestId of collectQuestPrerequisiteIds(quest)) {
        if (!hasClearedQuest(requiredQuestId)) {
            return { ok: false, message: "Required quest is not cleared." }
        }
    }
    return { ok: true }
}

export function canStartQuestBySelectableNeed(
    quest: QuestStartPrerequisites,
    hasClearedQuest: (questId: number) => boolean,
): { ok: true } | { ok: false, message: string } {
    return canStartQuestByPrerequisites(quest, hasClearedQuest)
}

export function hasClearedQuestPrerequisiteForCategory(
    category: number,
    requiredQuestId: number,
    getProgress: (section: number, questId: number) => QuestProgressForStart | null,
): boolean {
    if (category === QuestCategory.ADVENT_EVENT_SINGLE || category === QuestCategory.ADVENT_EVENT_MULTI) {
        return (
            getProgress(QuestCategory.ADVENT_EVENT_SINGLE, requiredQuestId)?.finished === true ||
            getProgress(QuestCategory.ADVENT_EVENT_MULTI, requiredQuestId)?.finished === true
        )
    }

    return getProgress(category, requiredQuestId)?.finished === true
}

export function hasClearedSelectableNeedQuestForCategory(
    category: number,
    requiredQuestId: number,
    getProgress: (section: number, questId: number) => QuestProgressForStart | null,
): boolean {
    return hasClearedQuestPrerequisiteForCategory(category, requiredQuestId, getProgress)
}
