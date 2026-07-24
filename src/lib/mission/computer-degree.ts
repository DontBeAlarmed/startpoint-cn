// Degree mission computer (category 5)

import { getPlayerSync } from "../../data/domains/player"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getRankDegree } from "../stamina"
import { getMissionMasterDefinition, getMissionMasterDefinitions } from "./master-data"
import { getMissionPattern } from "./patterns"
import type { MissionComputer, CategoryContext } from "./types"

// Degree mission target lookup
const degreeTargetMap: Record<number, number> = {}
{
    // Note: this import is resolved at module load time via the patterns file's data
    // but we use the same degreeDefs. For simplicity, inline the regex.
    const degreeDefs = require("../../../assets/mission_degree.json")
    const descRegex = /玩家(?:达到|级别达到)\s*(\d+)/
    for (const [mid, rows] of Object.entries(degreeDefs as Record<string, any>)) {
        const row = (rows as any[])[0]
        if (!row || !row[2]) continue
        const match = descRegex.exec(String(row[2]))
        if (match) degreeTargetMap[parseInt(mid)] = parseInt(match[1])
    }
}

export function getTargetDegree(missionId: number): number | undefined {
    return degreeTargetMap[missionId]
}

function buildStats(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const characters = getPlayerCharactersSync(playerId)
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const battleCounters = getMissionBattleCountersSync(playerId)
    const questProgress = getPlayerQuestProgressSync(playerId)
    return {
        category,
        playerId,
        player,
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        battleCounters,
        degreeStats: {
            companionCount: Object.keys(characters).length,
            overLimitCount: Object.values(characters)
                .reduce((total, character) => total + character.overLimitStep, 0),
            manaBoardCount: Object.values(manaNodes)
                .reduce((total, nodes) => total + nodes.length, 0),
            bondTokenCount: Object.values(characters)
                .reduce((total, character) => total
                    + character.bondTokenList.filter(token => token.status >= 1).length, 0),
            singleSsCount: battleCounters.singleRankSsCount,
            multiClearCount: battleCounters.multiClearCount,
            multiHostClearCount: battleCounters.multiHostClearCount,
            episodeClearCount: (questProgress["3"] || [])
                .filter(progress => progress.finished).length,
            bondedCharacterIds: new Set(Object.entries(characters)
                .filter(([, character]) => character.bondTokenList.some(token => token.status >= 1))
                .map(([characterId]) => Number(characterId))),
        },
    }
}

const SUPPORTED_FAMILIES = {
    playerRank: "degree_player_rank_growth_",
    companionCount: "degree_companion_add_",
    overLimitCount: "degree_overlimit_growth_",
    manaBoardCount: "degree_manaboard_growth_",
    bondTokenCount: "degree_proof_of_bond_get_",
    singleSsCount: "degree_rank_ss_clear_single_",
    multiClearCount: "degree_multi_battle_clear_",
    multiHostClearCount: "degree_multi_battle_by_host_clear_",
    episodeClearCount: "degree_character_episode_read_",
} as const

export function getDegreeMissionCoverageReport() {
    const definitions = getMissionMasterDefinitions(5)
    const prefixFamilies = Object.fromEntries(
        Object.entries(SUPPORTED_FAMILIES).map(([name, prefix]) => [
            name,
            definitions.filter(definition => definition.pattern.startsWith(prefix)).length,
        ]),
    ) as Record<keyof typeof SUPPORTED_FAMILIES, number>
    const supportedFamilies = {
        ...prefixFamilies,
        specificCharacterBond: definitions.filter(definition => (
            Number(definition.row[3]) === 44
            && getSpecificCharacterBondId(definition.missionId) !== undefined
        )).length,
    }
    const serverComputed = Object.values(supportedFamilies).reduce((sum, count) => sum + count, 0)
    return {
        total: definitions.length,
        serverComputed,
        unsupported: definitions.length - serverComputed,
        supportedFamilies,
    }
}

export function getSpecificCharacterBondId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition || Number(definition.row[3]) !== 44) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

export const DegreeComputer: MissionComputer = {
    name: "Degree",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildStats(playerId, category)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const pattern = getMissionPattern(5, missionId)
        const stats = ctx.degreeStats
        if (pattern.startsWith(SUPPORTED_FAMILIES.playerRank)) return getRankDegree(ctx.player.rankPoint)
        if (!stats) return dbProgress
        const bondCharacterId = getSpecificCharacterBondId(missionId)
        if (bondCharacterId !== undefined) {
            return Math.max(dbProgress, stats.bondedCharacterIds.has(bondCharacterId) ? 1 : 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.companionCount)) return stats.companionCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.overLimitCount)) return stats.overLimitCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.manaBoardCount)) return stats.manaBoardCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.bondTokenCount)) return stats.bondTokenCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.singleSsCount)) return stats.singleSsCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.multiClearCount)) {
            return Math.max(dbProgress, stats.multiClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.multiHostClearCount)) {
            return Math.max(dbProgress, stats.multiHostClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.episodeClearCount)) {
            return Math.max(dbProgress, stats.episodeClearCount)
        }
        return dbProgress
    },
}
