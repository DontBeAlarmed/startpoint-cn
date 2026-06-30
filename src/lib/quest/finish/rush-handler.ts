import { RushEventBattleType } from "../../../data/types"
import type { UserRushEventPlayedParty } from "../../../data/types"
import type { PlayerRewardResult, EquipmentItemReward, RushEventFolder } from "../../types"
import { QuestCategory } from "../../types"

interface ReturnRushEvent {
    rush_battle_reward_list: { kind: number, kind_id: number, number: number }[]
    rush_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null
    endless_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null
    is_out_of_period: boolean
    endless_battle_next_round: number | null
    endless_battle_max_round: number | null
    high_score: number | null
    best_elapsed_time_ms: number | null
    old_endless_battle_max_round: number | null
    old_best_elapsed_time_ms: number | null
}

interface RushHandlerParams {
    questCategory: number
    questData: {
        rushEventId?: number
        rushEventFolderId?: RushEventFolder
        rushEventRound?: number
    }
    clearTime: number
    party: {
        characters: ({ id: number | null } | null)[]
        unison_characters: ({ id: number | null } | null)[]
        equipments: ({ id: number | null } | null)[]
        ability_soul_ids: (number | null)[]
    }
    playerId: number
    questId: number
    getEvoLevels: (playerId: number, charIds: (number | null)[]) => (number | null)[]
    folderMaxRounds: Record<number, number | undefined>
    getRushEvent: (playerId: number, eventId: number) => any | null
    updateRushEvent: (playerId: number, data: any) => void
    insertParty: (playerId: number, eventId: number, data: any) => void
    insertClearedFolder: (playerId: number, eventId: number, folderId: number) => void
    deletePartyList: (playerId: number, eventId: number, battleType: number) => void
    getSerializedParties: (playerId: number, eventId: number) => any
    getFolderRewards: (eventId: number, folderId: number) => any[] | null
    giveRewards: (playerId: number, rewards: any[]) => any | null
}

export function handleRushEventFinish(params: RushHandlerParams): {
    rushEventData: ReturnRushEvent | null
    rushEventRewardsResult: PlayerRewardResult | null
} {
    const { questCategory, questData, clearTime, party, playerId, questId,
        getEvoLevels, folderMaxRounds, getRushEvent, updateRushEvent,
        insertParty, insertClearedFolder, deletePartyList,
        getSerializedParties, getFolderRewards, giveRewards } = params

    let rushEventData: ReturnRushEvent | null = null
    let rushEventRewardsResult: PlayerRewardResult | null = null

    if (questCategory !== QuestCategory.RUSH_EVENT) {
        return { rushEventData, rushEventRewardsResult }
    }

    const rushEventId = questData.rushEventId
    const rushEventFolderId = questData.rushEventFolderId
    const rushEventRound = questData.rushEventRound

    if (rushEventFolderId === undefined || rushEventRound === undefined || rushEventId === undefined) {
        return { rushEventData, rushEventRewardsResult }
    }

    const rushEventBattleType = rushEventRound === 0 ? RushEventBattleType.ENDLESS : RushEventBattleType.FOLDER

    const characterIds = party.characters.map(val => val?.id ?? null)
    const unisonCharacterIds = party.unison_characters.map(val => val?.id ?? null)
    const evolutionImgLevels: (number | null)[] = getEvoLevels(playerId, characterIds)
    const unisonEvolutionImgLevels: (number | null)[] = getEvoLevels(playerId, unisonCharacterIds)

    let round: number = questId
    let oldEndlessMaxRound: number | null = null
    let oldBestElapsedTimeMs: number | null = null
    let newEndlessMaxRound: number | null = null
    let newEndlessNextRound: number | null = null
    let newBestElapsedTimeMs: number | null = null

    if (rushEventBattleType === RushEventBattleType.ENDLESS) {
        const playerRushEventData = getRushEvent(playerId, rushEventId)
        const playerNextRound = playerRushEventData?.endlessBattleNextRound ?? 1
        const playerMaxRound = playerRushEventData?.endlessBattleMaxRound ?? 1
        const playerBestClearTime = playerRushEventData?.endlessBattleMaxRoundTime ?? Number.MAX_SAFE_INTEGER
        round = playerNextRound

        oldEndlessMaxRound = playerMaxRound
        oldBestElapsedTimeMs = playerBestClearTime < Number.MAX_SAFE_INTEGER ? playerBestClearTime : null

        const isNewRecord = (playerNextRound >= playerMaxRound && playerBestClearTime >= clearTime) || (playerNextRound > playerMaxRound)
        if (isNewRecord) {
            updateRushEvent(playerId, {
                eventId: rushEventId,
                endlessBattleMaxRound: playerNextRound,
                endlessBattleMaxRoundTime: clearTime,
                endlessBattleMaxRoundCharacterIds: characterIds,
                endlessBattleMaxRoundCharacterEvolutionImgLvls: evolutionImgLevels
            })
            newEndlessMaxRound = playerNextRound
            newBestElapsedTimeMs = clearTime
        } else {
            newEndlessMaxRound = playerMaxRound
            newBestElapsedTimeMs = playerBestClearTime < Number.MAX_SAFE_INTEGER ? playerBestClearTime : null
        }
        newEndlessNextRound = playerNextRound + 1

        insertParty(playerId, rushEventId, {
            characterIds, unisonCharacterIds,
            equipmentIds: party.equipments.map(val => val?.id ?? null),
            abilitySoulIds: party.ability_soul_ids,
            evolutionImgLevels, unisonEvolutionImgLevels,
            battleType: rushEventBattleType, round
        })
    } else if (rushEventBattleType === RushEventBattleType.FOLDER) {
        const isFolderFinal = rushEventRound >= (folderMaxRounds[rushEventFolderId] ?? 0)
        if (isFolderFinal) {
            insertClearedFolder(playerId, rushEventId, rushEventFolderId)
            updateRushEvent(playerId, { eventId: rushEventId, activeRushBattleFolderId: null })
            deletePartyList(playerId, rushEventId, rushEventBattleType)
        } else {
            insertParty(playerId, rushEventId, {
                characterIds, unisonCharacterIds,
                equipmentIds: party.equipments.map(val => val?.id ?? null),
                abilitySoulIds: party.ability_soul_ids,
                evolutionImgLevels, unisonEvolutionImgLevels,
                battleType: rushEventBattleType, round
            })
        }
    }

    const serializedPlayedParties = getSerializedParties(playerId, rushEventId)
    const isEndless = rushEventBattleType === RushEventBattleType.ENDLESS
    rushEventData = {
        "rush_battle_reward_list": [],
        "rush_battle_played_party_list": serializedPlayedParties.folderParties,
        "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
        "is_out_of_period": false,
        "endless_battle_next_round": isEndless ? newEndlessNextRound : null,
        "endless_battle_max_round": isEndless ? newEndlessMaxRound : null,
        "high_score": isEndless ? clearTime : null,
        "best_elapsed_time_ms": isEndless ? newBestElapsedTimeMs : null,
        "old_endless_battle_max_round": isEndless ? oldEndlessMaxRound : null,
        "old_best_elapsed_time_ms": isEndless ? oldBestElapsedTimeMs : null
    }

    if (rushEventBattleType === RushEventBattleType.FOLDER && rushEventRound >= (folderMaxRounds[rushEventFolderId] ?? 0)) {
        const rewards = getFolderRewards(rushEventId, rushEventFolderId) ?? []
        rushEventRewardsResult = giveRewards(playerId, rewards)
        rushEventData.rush_battle_reward_list = rewards.map(reward => {
            const itemReward = reward as EquipmentItemReward
            return { "kind": 1, "kind_id": itemReward.id, "number": itemReward.count }
        })
    }

    return { rushEventData, rushEventRewardsResult }
}
