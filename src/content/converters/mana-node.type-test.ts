import type { ManaNode } from "../../lib/types"
import {
    parseManaNodeEvolutionSemantics,
    type ManaNodeEvolutionSemantics,
} from "../mana-node-semantics"

function assertManaNodeEvolutionSemantics(node: ManaNode): void {
    const semantics: ManaNodeEvolutionSemantics = parseManaNodeEvolutionSemantics(node)
    const slot: number | null = semantics.abilitySlotIndex
    const requisite: boolean = semantics.isSkillEvolutionRequisite

    void slot
    void requisite
}

void assertManaNodeEvolutionSemantics
