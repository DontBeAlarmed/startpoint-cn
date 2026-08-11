import {
    PlayerRushEvent,
    PlayerRushEventPlayedParty,
    RushEventBattleType,
} from "../data/types"
import { BattleQuest } from "./types"

interface RushFolderBattleStartValidation {
    quest: BattleQuest
    rushEvent: PlayerRushEvent | null
    playedParties: readonly PlayerRushEventPlayedParty[]
    getQuest: (questId: number) => BattleQuest | null
}

function isPositiveSafeInteger(value: number | undefined): value is number {
    return Number.isSafeInteger(value) && value !== undefined && value > 0
}

function isFolderQuestForEvent(
    quest: BattleQuest | null,
    eventId: number,
    folderId: number,
): boolean {
    return quest !== null
        && quest.rushEventId === eventId
        && quest.rushEventFolderId === folderId
        && isPositiveSafeInteger(quest.rushEventRound)
}

export function canStartRushEventFolderBattle({
    quest,
    rushEvent,
    playedParties,
    getQuest,
}: RushFolderBattleStartValidation): boolean {
    const eventId = quest.rushEventId
    const folderId = quest.rushEventFolderId
    const round = quest.rushEventRound
    if (!isPositiveSafeInteger(eventId)
        || !isPositiveSafeInteger(folderId)
        || !isPositiveSafeInteger(round)
        || rushEvent === null
        || rushEvent.eventId !== eventId
        || rushEvent.activeRushBattleFolderId !== folderId) return false

    const folderParties = playedParties.filter(
        party => party.battleType === RushEventBattleType.FOLDER,
    )
    if (!folderParties.every(party => (
        Number.isSafeInteger(party.round)
        && isFolderQuestForEvent(getQuest(party.round), eventId, folderId)
    ))) return false

    const completedRounds = folderParties
        .map(party => getQuest(party.round)!.rushEventRound!)
        .sort((left, right) => left - right)
    if (!completedRounds.every((completedRound, index) => completedRound === index + 1)) return false

    return round === folderParties.length + 1
}
