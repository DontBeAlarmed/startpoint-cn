import { RushEventBattleType } from "../../../data/types"
import { QuestCategory } from "../../types"

export interface RaidBossState {
    readonly weightedKillCount: number
    readonly totalKillCount: number
}

export interface RaidEventFinishData {
    auto_start_point: number
    is_out_of_period: boolean
    quest_boss: { kill_count: number }
    raid_boss: { hp_percentage: number, total_kill_count: number }
}

export function advanceRaidBossState(
    state: RaidBossState,
    killCountWeight: number,
    requiredKillCount: number,
): RaidBossState {
    if (!Number.isSafeInteger(state.weightedKillCount) || state.weightedKillCount < 0
        || !Number.isSafeInteger(state.totalKillCount) || state.totalKillCount < 0
        || !Number.isSafeInteger(killCountWeight) || killCountWeight <= 0
        || !Number.isSafeInteger(requiredKillCount) || requiredKillCount <= 0) {
        throw new Error("invalid raid boss progress")
    }
    const weightedKillCount = state.weightedKillCount + killCountWeight
    return weightedKillCount >= requiredKillCount
        ? { weightedKillCount: 0, totalKillCount: state.totalKillCount + 1 }
        : { weightedKillCount, totalKillCount: state.totalKillCount }
}

export function getRaidBossHpPercentage(state: RaidBossState, requiredKillCount: number): number {
    if (!Number.isSafeInteger(requiredKillCount) || requiredKillCount <= 0) {
        throw new Error("invalid raid boss required kill count")
    }
    return Math.ceil((1 - state.weightedKillCount / requiredKillCount) * 1000) / 10
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
    getRequiredKillCountFn: (eventId: number) => number | undefined
    getRaidBossStateFn: (eventId: number) => RaidBossState | null
    updateRaidBossStateFn: (eventId: number, state: RaidBossState) => void
    incrementQuestKillCountFn: (playerId: number, eventId: number, questId: number) => number
}): RaidEventFinishData | null {
    const {
        questCategory, questAccomplished, activeEventId, killCountWeight, party, playerId, questId,
        getEvoLevelsFn, insertPartyFn, getRequiredKillCountFn, getRaidBossStateFn,
        updateRaidBossStateFn, incrementQuestKillCountFn,
    } = params

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

    const requiredKillCount = getRequiredKillCountFn(activeEventId)
    if (requiredKillCount === undefined) throw new Error(`raid event ${activeEventId} has no required kill count`)
    if (typeof killCountWeight !== "number"
        || !Number.isSafeInteger(killCountWeight)
        || killCountWeight <= 0) {
        throw new Error(`invalid raid quest kill count weight: ${String(killCountWeight)}`)
    }
    const nextState = advanceRaidBossState(
        getRaidBossStateFn(activeEventId) ?? { weightedKillCount: 0, totalKillCount: 0 },
        killCountWeight,
        requiredKillCount,
    )
    updateRaidBossStateFn(activeEventId, nextState)
    const questKillCount = incrementQuestKillCountFn(playerId, activeEventId, questId)

    return {
        auto_start_point: 0,
        is_out_of_period: false,
        quest_boss: { kill_count: questKillCount },
        raid_boss: {
            hp_percentage: getRaidBossHpPercentage(nextState, requiredKillCount),
            total_kill_count: nextState.totalKillCount,
        },
    }
}
