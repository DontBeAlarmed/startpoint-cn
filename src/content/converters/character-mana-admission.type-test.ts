import type {
    CharacterManaAdmissionConversionOutput,
    LevelRequiredManaNodeRow,
} from "./character-mana-admission"
import type {
    CharacterLevelTable,
    LevelRequiredManaNodeTable,
} from "../character-mana-admission"
import type { ManaBoardParentIndex } from "../mana-board-parent-index"

declare const output: CharacterManaAdmissionConversionOutput
declare const requirementTable: LevelRequiredManaNodeTable
declare const characterLevels: CharacterLevelTable
declare const parents: ManaBoardParentIndex

const row: LevelRequiredManaNodeRow = output["level_required_mana_node.json"]["5"]
const abilityLevel: number | null = row.abilityLevels[5]
const skillLevel: number | null = requirementTable["5"].skillEvolutionLevel
const totalExperience: number = characterLevels["1"]["100"]
const parent: number | null = parents["1"]["1"]["2201"]

void abilityLevel
void skillLevel
void totalExperience
void parent
