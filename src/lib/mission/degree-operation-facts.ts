import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import { getMissionMasterDefinition } from "./master-data"

export type DegreeOperationKind = "treasure_mana" | "equipment_upgrade"

const RULES: Readonly<Record<DegreeOperationKind, readonly number[]>> = {
    treasure_mana: [45000, 45010, 45020],
    equipment_upgrade: [42000, 42010, 42020],
}

const EXPECTED_TYPE: Readonly<Record<DegreeOperationKind, number>> = {
    treasure_mana: 3,
    equipment_upgrade: 34,
}

function validMissionIds(kind: DegreeOperationKind): readonly number[] {
    return RULES[kind].filter(missionId => (
        Number(getMissionMasterDefinition(5, missionId)?.row[3]) === EXPECTED_TYPE[kind]
    ))
}

export function getDegreeOperationRuleCount(): number {
    return validMissionIds("treasure_mana").length + validMissionIds("equipment_upgrade").length
}

export function getDegreeOperationMissionIds(): readonly number[] {
    return Object.freeze([
        ...validMissionIds("treasure_mana"),
        ...validMissionIds("equipment_upgrade"),
    ].sort((left, right) => left - right))
}

export function recordDegreeOperationFactsSync(
    playerId: number,
    kind: DegreeOperationKind,
    amount: number,
): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    for (const missionId of validMissionIds(kind)) {
        incrementPlayerCategoryMissionSync(playerId, 5, missionId, amount)
    }
}
