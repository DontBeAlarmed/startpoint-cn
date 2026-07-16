import { RushEventBattleType } from "../../../data/types"
import { QuestCategory } from "../../types"

export interface RaidEventFinishData {
    auto_start_point: number
    is_out_of_period: boolean
    quest_boss: { kill_count: number }
    raid_boss: { hp_percentage: number, total_kill_count: number }
}

export function handleRaidEventFinish(params: {
    questCategory: number
    questAccomplished: boolean
    activeEventId: number | undefined
    killCountWeight?: number
    party: { characters: ({ id: number | null } | null)[], unison_characters: ({ id: number | null } | null)[], equipments: ({ id: number | null } | null)[], ability_soul_ids: (number | null)[] }
    playerId: number
    questId: number
    getEvoLevelsFn: (playerId: number, charIds: (number | null)[]) => (number | null)[]
    insertPartyFn: (playerId: number, eventId: number, partyData: {
        characterIds: (number | null)[]
        unisonCharacterIds: (number | null)[]
        equipmentIds: (number | null)[]
        abilitySoulIds: (number | null)[]
        evolutionImgLevels: (number | null)[]
        unisonEvolutionImgLevels: (number | null)[]
        battleType: RushEventBattleType
        round: number
    }) => void
}): RaidEventFinishData | null {
    const { questCategory, questAccomplished, activeEventId, killCountWeight, party, playerId, questId, getEvoLevelsFn, insertPartyFn } = params

    if (questCategory !== QuestCategory.RAID_EVENT || !questAccomplished || activeEventId === undefined) return null

    const characterIds = party.characters.map(val => val?.id ?? null)
    const unisonCharacterIds = party.unison_characters.map(val => val?.id ?? null)
    const evolutionImgLevels = getEvoLevelsFn(playerId, characterIds)
    const unisonEvolutionImgLevels = getEvoLevelsFn(playerId, unisonCharacterIds)

    insertPartyFn(playerId, activeEventId, {
        characterIds, unisonCharacterIds,
        equipmentIds: party.equipments.map(val => val?.id ?? null),
        abilitySoulIds: party.ability_soul_ids,
        evolutionImgLevels,
        unisonEvolutionImgLevels,
        battleType: RushEventBattleType.FOLDER,
        round: questId
    })

    return {
        auto_start_point: 0,
        is_out_of_period: false,
        quest_boss: { kill_count: killCountWeight ?? 1 },
        raid_boss: { hp_percentage: 100, total_kill_count: 0 }
    }
}
