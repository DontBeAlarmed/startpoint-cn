import { getDb } from "../../data/db"
import type { PlayerCharacter } from "../../data/types"
import { getCharacterDataSync, getCharacterManaNodesSync } from "../assets"
import { InvalidManaNodeSemanticsError } from "../../content/mana-node-semantics"
import { buildCharacterEvolutionNodes, computeCharacterEvolutionLevel } from "../character-evolution"
import type { ManaNode } from "../types"

export interface AwakeEvolutionRepairSnapshot {
    readonly characters: Record<string, PlayerCharacter>
    readonly manaNodes: Record<string, number[]>
    readonly manaNodeAwakeLevels: Record<string, Record<number, number>>
}

export interface AwakeEvolutionRepairResult {
    readonly characters: Record<string, PlayerCharacter>
    readonly repairedCharacterIds: readonly number[]
}

interface PersistedRepairCharacter {
    readonly evolution_level: number
}

function parseNodeIds(learnedNodeIds: readonly number[]): Set<number> | null {
    const nodeIds = new Set<number>()
    for (const rawNodeId of learnedNodeIds) {
        const nodeId = Number(rawNodeId)
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
        nodeIds.add(nodeId)
    }
    return nodeIds
}

function parseAwakeLevels(
    rawAwakeLevels: Record<number, number> | undefined,
): Map<number, number> | null {
    if (rawAwakeLevels === undefined || rawAwakeLevels === null) return new Map()
    if (typeof rawAwakeLevels !== "object" || Array.isArray(rawAwakeLevels)) return null

    const awakeLevels = new Map<number, number>()
    for (const [rawNodeId, rawAwakeLevel] of Object.entries(rawAwakeLevels)) {
        const nodeId = Number(rawNodeId)
        const awakeLevel = Number(rawAwakeLevel)
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
        if (!Number.isSafeInteger(awakeLevel) || awakeLevel < 0) return null
        awakeLevels.set(nodeId, awakeLevel)
    }
    return awakeLevels
}

function deriveEvolutionLevel(
    characterId: number,
    snapshot: AwakeEvolutionRepairSnapshot,
): number | null {
    if (getCharacterDataSync(characterId) === null) return null
    const boardNodes = getCharacterManaNodesSync(characterId, 1)
    if (!boardNodes || Object.keys(boardNodes).length === 0) return null

    const learnedNodeIds = parseNodeIds(snapshot.manaNodes[String(characterId)] ?? [])
    const awakeLevels = parseAwakeLevels(snapshot.manaNodeAwakeLevels[String(characterId)])
    if (learnedNodeIds === null || awakeLevels === null) return null

    try {
        return computeCharacterEvolutionLevel({
            nodes: buildCharacterEvolutionNodes(boardNodes as Record<string, ManaNode>),
            learnedNodeIds,
            awakeLevels,
        })
    } catch (error) {
        if (error instanceof InvalidManaNodeSemanticsError) return null
        throw error
    }
}

export function reconcileAwakeEvolutionLevelsSync(
    playerId: number,
    snapshot: AwakeEvolutionRepairSnapshot,
): AwakeEvolutionRepairResult {
    const characters = { ...snapshot.characters }
    const repairs = Object.keys(snapshot.characters)
        .map(key => Number(key))
        .filter(characterId => Number.isSafeInteger(characterId) && characterId > 0)
        .sort((left, right) => left - right)
        .flatMap(characterId => {
            const character = snapshot.characters[String(characterId)]
            const derivedEvolutionLevel = deriveEvolutionLevel(characterId, snapshot)
            if (derivedEvolutionLevel === null || derivedEvolutionLevel <= character.evolutionLevel) {
                return []
            }
            return [{ characterId, derivedEvolutionLevel }]
        })

    if (repairs.length === 0) {
        return { characters, repairedCharacterIds: [] }
    }

    const db = getDb()
    const updateEvolutionLevel = db.prepare(`
        UPDATE players_characters
        SET evolution_level = ?
        WHERE player_id = ? AND id = ? AND evolution_level < ?
    `)
    const readEvolutionLevel = db.prepare(`
        SELECT evolution_level
        FROM players_characters
        WHERE player_id = ? AND id = ?
    `)
    const repairedCharacterIds: number[] = []

    db.transaction(() => {
        for (const repair of repairs) {
            const changes = updateEvolutionLevel.run(
                repair.derivedEvolutionLevel,
                playerId,
                repair.characterId,
                repair.derivedEvolutionLevel,
            ).changes
            const persistedCharacter = readEvolutionLevel.get(
                playerId,
                repair.characterId,
            ) as PersistedRepairCharacter | undefined
            if (persistedCharacter === undefined) continue
            if (persistedCharacter.evolution_level < repair.derivedEvolutionLevel) {
                throw new Error(
                    `Failed to persist evolution repair for character ${repair.characterId}`,
                )
            }
            characters[String(repair.characterId)] = {
                ...snapshot.characters[String(repair.characterId)],
                evolutionLevel: persistedCharacter.evolution_level,
            }
            if (changes === 1) repairedCharacterIds.push(repair.characterId)
        }
    })()

    return { characters, repairedCharacterIds }
}
