import {
    buildCharacterEvolutionNodes,
    computeCharacterEvolutionLevel,
} from "../character-evolution"
import type { CharacterManaMutationContent, ManaNodeMutationPlan } from "../character-mana-mutation-types"
import type { CharacterGrowthCoreFact } from "./model"
import { growthError } from "./errors"

export function boardNodeIds(content: CharacterManaMutationContent): ReadonlySet<number> {
    return new Set(Object.keys(content.nodes).map(Number))
}

export function boardNodeLevels(
    allNodeLevels: ReadonlyMap<number, number>,
    content: CharacterManaMutationContent,
): ReadonlyMap<number, number> {
    const ids = boardNodeIds(content)
    return new Map([...allNodeLevels].filter(([nodeId]) => ids.has(nodeId)))
}

export function applyManaNodePlan(
    current: ReadonlyMap<number, number>,
    plan: Pick<ManaNodeMutationPlan, "finalAwakeLevels">,
): ReadonlyMap<number, number> {
    const next = new Map(current)
    for (const [rawNodeId, awakeLevel] of Object.entries(plan.finalAwakeLevels)) {
        next.set(Number(rawNodeId), awakeLevel)
    }
    return next
}

export function assertNormalBoardOwnership(
    character: CharacterGrowthCoreFact,
    boardId: number,
): void {
    if (boardId !== character.manaBoardIndex) {
        throw growthError(
            "INVALID_GROWTH_STATE",
            `request board ${boardId} does not match persisted board ${character.manaBoardIndex}.`,
        )
    }
}

export function assertBoardComplete(
    nodeLevels: ReadonlyMap<number, number>,
    content: CharacterManaMutationContent,
): void {
    const learned = new Set(nodeLevels.keys())
    for (const nodeId of boardNodeIds(content)) {
        if (!learned.has(nodeId)) {
            throw growthError("PREVIOUS_BOARD_INCOMPLETE", "mana board one is not complete.")
        }
    }
}

export function deriveEvolutionLevel(
    boardOneContent: CharacterManaMutationContent,
    allNodeLevels: ReadonlyMap<number, number>,
): number {
    return computeCharacterEvolutionLevel({
        nodes: buildCharacterEvolutionNodes(boardOneContent.nodes),
        learnedNodeIds: new Set(allNodeLevels.keys()),
        awakeLevels: allNodeLevels,
    })
}

export function deriveManaBoardAwake(
    nodeLevels: ReadonlyMap<number, number>,
    boardOneContent: CharacterManaMutationContent,
    targetAwakeLevel: number,
): Record<number, number> | undefined {
    if ([...boardNodeIds(boardOneContent)].every(nodeId => (
        (nodeLevels.get(nodeId) ?? 0) >= targetAwakeLevel
    ))) {
        return { 1: targetAwakeLevel }
    }
    return undefined
}
