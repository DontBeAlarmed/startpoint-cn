import bundledCharacters from "../../assets/character.json"
import bundledEquipmentDissolve from "../../assets/equipment_dissolve.json"

import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import { getDb } from "../data/db"
import { getPlayerCharactersSync } from "../data/domains/character"
import { getPlayerEquipmentListSync } from "../data/domains/equipment"
import { getPlayerHistoryMilestonesSync } from "../data/domains/player-history-facts"
import type { Player } from "../data/types"
import { characterExpCaps } from "./character"
import {
    createEmptyPlayerHistoryTopicValues,
    PlayerHistoryTopicValueList,
} from "./player-history-catalog"

interface AggregateCounters {
    readonly regularMissionCount: number
    readonly mvpCount: number
    readonly multiHostClearCount: number
    readonly multiGuestClearCount: number
    readonly expertSingleClearCount: number
    readonly towerFloorClearCount: number
}

interface RawAggregateCounters {
    regular_mission_count: number
    mvp_count: number | null
    multi_host_clear_count: number | null
    multi_guest_clear_count: number | null
    expert_single_clear_count: number
    tower_floor_clear_count: number
}

type CharacterTable = Record<string, { readonly rarity?: unknown }>
type EquipmentDissolveTable = Record<string, { readonly max_level?: unknown }>

const GUILD_GIRL_EQUIPMENT_IDS = Object.freeze([
    5010045, 5040020, 5100011, 5030028, 5010032, 5010056,
])

function getAggregateCountersSync(playerId: number): AggregateCounters {
    const row = getDb().prepare(`
        SELECT
            (SELECT COUNT(*) FROM players_cleared_regular_missions WHERE player_id = ?) AS regular_mission_count,
            (SELECT progress FROM players_category_missions WHERE player_id = ? AND category = 1 AND id = 29) AS mvp_count,
            (SELECT multi_host_clear_count FROM players_mission_battle_counters WHERE player_id = ?) AS multi_host_clear_count,
            (SELECT multi_guest_clear_count FROM players_mission_battle_counters WHERE player_id = ?) AS multi_guest_clear_count,
            (SELECT COUNT(*) FROM players_quest_progress WHERE player_id = ? AND section = 21 AND finished = 1) AS expert_single_clear_count,
            (SELECT COUNT(*) FROM players_quest_progress WHERE player_id = ? AND section = 20 AND finished = 1) AS tower_floor_clear_count
    `).get(playerId, playerId, playerId, playerId, playerId, playerId) as RawAggregateCounters
    return {
        regularMissionCount: row.regular_mission_count,
        mvpCount: row.mvp_count ?? 0,
        multiHostClearCount: row.multi_host_clear_count ?? 0,
        multiGuestClearCount: row.multi_guest_clear_count ?? 0,
        expertSingleClearCount: row.expert_single_clear_count,
        towerFloorClearCount: row.tower_floor_clear_count,
    }
}

function isLevel100(rarity: number, experience: number): boolean {
    const thresholds = characterExpCaps[rarity]
    if (!Array.isArray(thresholds) || thresholds.length === 0) return false
    const baseLevel = 40 + (rarity - 1) * 10
    let level = 0
    for (let index = 0; index < thresholds.length; index++) {
        if (experience >= thresholds[index]) level = baseLevel + index * 5
    }
    return level >= 100
}

function withInts(target: number, values: number[]): PlayerHistoryTopicValueList {
    return { ...createEmptyPlayerHistoryTopicValues(target), int_values: values }
}

export function loadPlayerHistoryTopicValuesSync(
    playerId: number,
    player: Pick<Player, "totalLoginDays">,
): ReadonlyMap<number, PlayerHistoryTopicValueList> {
    const characters = getPlayerCharactersSync(playerId)
    const equipment = getPlayerEquipmentListSync(playerId)
    const counters = getAggregateCountersSync(playerId)
    const characterTable = getRuntimeContentTableSync(
        "character.json",
        bundledCharacters as CharacterTable,
    ) as CharacterTable
    const equipmentTable = getRuntimeContentTableSync(
        "equipment_dissolve.json",
        bundledEquipmentDissolve as EquipmentDissolveTable,
    ) as EquipmentDissolveTable

    const level100Count = Object.entries(characters).reduce((count, [characterId, character]) => {
        const rarity = Number(characterTable[characterId]?.rarity)
        return Number.isSafeInteger(rarity) && isLevel100(rarity, character.exp) ? count + 1 : count
    }, 0)
    const bondTokenCount = Object.values(characters).reduce((count, character) => (
        count + character.bondTokenList.filter(token => token.status >= 1).length
    ), 0)
    const maxLevelEquipmentCount = Object.entries(equipment).reduce((count, [equipmentId, owned]) => {
        const maxLevel = Number(equipmentTable[equipmentId]?.max_level)
        return Number.isSafeInteger(maxLevel) && maxLevel > 0 && owned.level >= maxLevel
            ? count + 1
            : count
    }, 0)
    const guildGirlValues = GUILD_GIRL_EQUIPMENT_IDS.flatMap(equipmentId => {
        const owned = equipment[String(equipmentId)]
        return owned ? [owned.level, owned.enhancementLevel] : [null, null]
    })

    const result = new Map<number, PlayerHistoryTopicValueList>([
        [1, withInts(1, [player.totalLoginDays])],
        [5, withInts(5, [level100Count])],
        [6, withInts(6, [bondTokenCount])],
        [9, withInts(9, [counters.regularMissionCount])],
        [11, withInts(11, [counters.mvpCount])],
        [12, withInts(12, [counters.multiHostClearCount, counters.multiGuestClearCount])],
        [13, withInts(13, [Object.keys(equipment).length])],
        [14, withInts(14, [maxLevelEquipmentCount])],
        [16, {
            ...createEmptyPlayerHistoryTopicValues(16),
            int_values: guildGirlValues,
        }],
        [21, withInts(21, [counters.expertSingleClearCount])],
        [23, withInts(23, [counters.towerFloorClearCount])],
    ])

    for (const milestone of getPlayerHistoryMilestonesSync(playerId)) {
        const current = result.get(milestone.aggregationTarget)
            ?? createEmptyPlayerHistoryTopicValues(milestone.aggregationTarget)
        const dateValues = current.date_values === null ? null : [...current.date_values]
        const characterIds = current.character_id_values === null
            ? null
            : [...current.character_id_values]
        const bossIds = current.boss_id_values === null ? null : [...current.boss_id_values]
        if (dateValues !== null) dateValues[milestone.slot] = milestone.occurredAt.toISOString()
        if (milestone.aggregationTarget === 4 && characterIds !== null) {
            characterIds[milestone.slot] = milestone.subjectId ?? null
        }
        if (milestone.aggregationTarget === 26 && bossIds !== null) {
            bossIds[milestone.slot] = milestone.subjectId ?? null
        }
        result.set(milestone.aggregationTarget, {
            ...current,
            date_values: dateValues,
            character_id_values: characterIds,
            boss_id_values: bossIds,
        })
    }
    return result
}
