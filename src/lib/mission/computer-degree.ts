// Degree mission computer (category 5)

import { getPlayerSync } from "../../data/domains/player"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { countFinishedPlayerQuestsByCategorySync } from "../../data/domains/quest"
import { getRankDegree } from "../stamina"
import bundledManaBoard from "../../../assets/mana_board.json"
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../../content/runtime/content-snapshot"
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

type RawManaBoard = Record<string, Record<string, Record<string, readonly unknown[][]>>>

function getManaBoardTable(): RawManaBoard {
    try {
        return getContentSnapshot().repository.table<RawManaBoard>("mana_board.json")
    } catch (error) {
        // Keep legacy bundled startup and direct unit tests compatible before
        // the runtime content snapshot has been initialized.
        if (error instanceof ContentSnapshotError
            && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
            return bundledManaBoard as RawManaBoard
        }
        throw error
    }
}

function getSecondManaBoardNodeIds(characterId: string): ReadonlySet<number> | null {
    const board = getManaBoardTable()[characterId]?.["2"]
    if (!board || Object.keys(board).length === 0) return null

    const nodeIds = new Set<number>()
    for (const rows of Object.values(board)) {
        const row = rows[0]
        const nodeId = Number(row?.[0])
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
        nodeIds.add(nodeId)
    }
    return nodeIds.size > 0 ? nodeIds : null
}

function getSecondManaBoardStats(
    characters: Record<string, unknown>,
    manaNodes: Record<string, number[]>,
): {
    nodeCount: number
    completedCharacterIds: ReadonlySet<number>
} {
    let nodeCount = 0
    const completedCharacterIds = new Set<number>()

    for (const characterId of Object.keys(characters)) {
        const nodeIds = getSecondManaBoardNodeIds(characterId)
        if (nodeIds === null) continue

        const learned = new Set(manaNodes[characterId] ?? [])
        let learnedSecondBoardNodes = 0
        for (const nodeId of nodeIds) {
            if (learned.has(nodeId)) learnedSecondBoardNodes++
        }
        nodeCount += learnedSecondBoardNodes
        if (learnedSecondBoardNodes === nodeIds.size) {
            const numericCharacterId = Number(characterId)
            if (Number.isSafeInteger(numericCharacterId)) {
                completedCharacterIds.add(numericCharacterId)
            }
        }
    }

    return { nodeCount, completedCharacterIds }
}

function buildStats(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const characters = getPlayerCharactersSync(playerId)
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const battleCounters = getMissionBattleCountersSync(playerId)
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
            episodeClearCount: countFinishedPlayerQuestsByCategorySync(playerId, 3),
            bondedCharacterIds: new Set(Object.entries(characters)
                .filter(([, character]) => character.bondTokenList.some(token => token.status >= 1))
                .map(([characterId]) => Number(characterId))),
            ...(() => {
                const secondManaBoard = getSecondManaBoardStats(characters, manaNodes)
                return {
                    secondManaBoardNodeCount: secondManaBoard.nodeCount,
                    secondManaBoardCompletedCharacterIds: secondManaBoard.completedCharacterIds,
                }
            })(),
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

function getSecondManaBoardCharacterId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition || Number(definition.row[3]) !== 48) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

function isSecondManaBoardAggregateMission(missionId: number): boolean {
    const definition = getMissionMasterDefinition(5, missionId)
    return Boolean(
        definition
        && Number(definition.row[3]) === 48
        && definition.pattern.startsWith("degree_manaboard_all_growth_"),
    )
}

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
        secondManaBoardNodeCount: definitions.filter(definition => (
            isSecondManaBoardAggregateMission(definition.missionId)
        )).length,
        secondManaBoardCompletion: definitions.filter(definition => (
            getSecondManaBoardCharacterId(definition.missionId) !== undefined
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
        const secondManaBoardCharacterId = getSecondManaBoardCharacterId(missionId)
        if (secondManaBoardCharacterId !== undefined) {
            return Math.max(
                dbProgress,
                stats.secondManaBoardCompletedCharacterIds.has(secondManaBoardCharacterId) ? 1 : 0,
            )
        }
        if (isSecondManaBoardAggregateMission(missionId)) {
            return Math.max(dbProgress, stats.secondManaBoardNodeCount)
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
