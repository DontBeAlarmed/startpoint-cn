import { QuestCategory, type BattleQuest } from "../../types"

export interface EventSettlementWindow {
    readonly availableFromMs: number | null
    readonly availableUntilMs: number | null
}

interface EventSettlementDescriptorBase {
    readonly questId: number
    readonly window: EventSettlementWindow
}

export type EventSettlementDescriptor =
    | Readonly<{ kind: "none" }>
    | Readonly<EventSettlementDescriptorBase & {
        kind: "rush"
        eventId: number
        folderId: number
        round: number
    }>
    | Readonly<EventSettlementDescriptorBase & {
        kind: "raid"
        eventId: number
        killCountWeight: number | undefined
    }>
    | Readonly<EventSettlementDescriptorBase & {
        kind: "carnival"
        eventId: number
        folderId: number
        difficultyScore: number
        timeLimitMs: number
    }>
    | Readonly<EventSettlementDescriptorBase & {
        kind: "scoreAttack"
        eventId: number
        scoreAttackQuestId: number
    }>

const NO_EVENT: EventSettlementDescriptor = Object.freeze({ kind: "none" })

function windowFor(quest: BattleQuest): EventSettlementWindow {
    return Object.freeze({
        availableFromMs: quest.availableFromMs ?? null,
        availableUntilMs: quest.availableUntilMs ?? null,
    })
}

/** Resolves built-in Event linkage from the already selected BattleQuest. */
export function createEventSettlementDescriptor(input: {
    readonly questCategory: number
    readonly questId: number
    readonly quest: BattleQuest
    readonly activeEventId?: number
}): EventSettlementDescriptor {
    const base = { questId: input.questId, window: windowFor(input.quest) }
    if (input.questCategory === QuestCategory.RUSH_EVENT) {
        if (input.quest.rushEventId === undefined
            || input.quest.rushEventFolderId === undefined
            || input.quest.rushEventRound === undefined) return NO_EVENT
        return Object.freeze({
            ...base,
            kind: "rush" as const,
            eventId: input.quest.rushEventId,
            folderId: input.quest.rushEventFolderId,
            round: input.quest.rushEventRound,
        })
    }
    if (input.questCategory === QuestCategory.RAID_EVENT) {
        if (input.activeEventId === undefined) return NO_EVENT
        return Object.freeze({
            ...base,
            kind: "raid" as const,
            eventId: input.activeEventId,
            killCountWeight: input.quest.killCountWeight,
        })
    }
    if (input.questCategory === QuestCategory.CARNIVAL_EVENT) {
        if (input.quest.eventId === undefined
            || input.quest.folderId === undefined
            || input.quest.difficultyScore === undefined
            || input.quest.timeLimitMs === undefined) return NO_EVENT
        return Object.freeze({
            ...base,
            kind: "carnival" as const,
            eventId: input.quest.eventId,
            folderId: input.quest.folderId,
            difficultyScore: input.quest.difficultyScore,
            timeLimitMs: input.quest.timeLimitMs,
        })
    }
    if (input.questCategory === QuestCategory.SCORE_ATTACK_EVENT) {
        if (input.quest.eventId === undefined
            || input.quest.scoreAttackQuestId === undefined) return NO_EVENT
        return Object.freeze({
            ...base,
            kind: "scoreAttack" as const,
            eventId: input.quest.eventId,
            scoreAttackQuestId: input.quest.scoreAttackQuestId,
        })
    }
    return NO_EVENT
}
