import { parseManaNodeEvolutionSemantics } from "../content/mana-node-semantics"
import type { ManaNode } from "./types"

export interface CharacterEvolutionNode {
    readonly id: number
    readonly abilitySlotIndex: number | null
    readonly isSkillEvolutionRequisite: boolean
}

export interface CharacterEvolutionInput {
    readonly nodes: readonly CharacterEvolutionNode[]
    readonly learnedNodeIds: ReadonlySet<number>
    readonly awakeLevels: ReadonlyMap<number, number>
}

function isFirstManaBoardNode(nodeId: number): boolean {
    return Math.trunc(nodeId / 200) % 10 === 1
}

export function buildCharacterEvolutionNodes(
    nodes: Readonly<Record<string, ManaNode>>,
): CharacterEvolutionNode[] {
    return Object.entries(nodes).map(([nodeId, node]) => ({
        id: Number(nodeId),
        ...parseManaNodeEvolutionSemantics(node),
    }))
}

export function buildCharacterEvolutionResponse(
    characterId: number,
    previousLevel: number,
    level: number,
): Object {
    return level > previousLevel
        ? { "character_id": characterId, "level": level, "img_level": level }
        : []
}

export function computeCharacterEvolutionLevel({
    nodes,
    learnedNodeIds,
    awakeLevels,
}: CharacterEvolutionInput): number {
    const abilitySlotGroups = new Map<number, number[]>()
    const skillEvolutionRequisiteNodeIds: number[] = []

    for (const node of nodes) {
        if (!isFirstManaBoardNode(node.id)) continue

        if (node.abilitySlotIndex !== null) {
            const group = abilitySlotGroups.get(node.abilitySlotIndex) ?? []
            group.push(node.id)
            abilitySlotGroups.set(node.abilitySlotIndex, group)
        }
        if (node.isSkillEvolutionRequisite) {
            skillEvolutionRequisiteNodeIds.push(node.id)
        }
    }

    const learnedEveryAbilitySlot = [...abilitySlotGroups.values()]
        .every(group => group.some(nodeId => learnedNodeIds.has(nodeId)))
    const learnedSkillEvolutionRequisite = skillEvolutionRequisiteNodeIds.length === 0
        || skillEvolutionRequisiteNodeIds.some(nodeId => learnedNodeIds.has(nodeId))
    if (!learnedEveryAbilitySlot || !learnedSkillEvolutionRequisite) return 0

    const firstSkillEvolutionNodeId = skillEvolutionRequisiteNodeIds[0]
    const awakeLevel = firstSkillEvolutionNodeId === undefined
        ? 0
        : (awakeLevels.get(firstSkillEvolutionNodeId) ?? 0)
    return awakeLevel > 0 ? 1 + awakeLevel : 1
}
