import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import { getMissionMasterDefinition } from "./master-data"

export type DegreeOperationKind = "treasure_mana" | "equipment_upgrade"

export interface AbilitySoulLoadout {
    readonly abilitySoulIds: readonly (number | null)[]
}

const RULES: Readonly<Record<DegreeOperationKind, readonly number[]>> = {
    treasure_mana: [45000, 45010, 45020],
    equipment_upgrade: [42000, 42010, 42020],
}

const EXPECTED_TYPE: Readonly<Record<DegreeOperationKind, number>> = {
    treasure_mana: 3,
    equipment_upgrade: 34,
}

const REGULAR_RULES: Readonly<Record<DegreeOperationKind, {
    readonly missionId: number
    readonly pattern: string
}>> = {
    treasure_mana: { missionId: 41, pattern: "treasure_shop_used_mana_count" },
    equipment_upgrade: { missionId: 67, pattern: "total_equipment_awaking_count" },
}

const ABILITY_SOUL_DEGREE_MISSION_IDS = [8000, 8010, 8020] as const

function isAbilitySoulDefinitionSupported(missionId: number): boolean {
    return getMissionMasterDefinition(5, missionId)?.pattern
        === `degree_abilitiesoul_use_${missionId === 8000 ? 1 : missionId === 8010 ? 2 : 3}`
}

export function countAbilitySoulEquipments(
    previous: readonly AbilitySoulLoadout[],
    current: readonly AbilitySoulLoadout[],
): number {
    let count = 0
    for (let partyIndex = 0; partyIndex < current.length; partyIndex++) {
        const oldIds = previous[partyIndex]?.abilitySoulIds ?? []
        const newIds = current[partyIndex]?.abilitySoulIds ?? []
        const slotCount = Math.max(oldIds.length, newIds.length)
        for (let slot = 0; slot < slotCount; slot++) {
            const oldId = oldIds[slot]
            const newId = newIds[slot]
            if (typeof newId === "number"
                && Number.isSafeInteger(newId)
                && newId > 0
                && newId !== oldId) count++
        }
    }
    return count
}

export function recordAbilitySoulEquipFactsSync(
    playerId: number,
    previous: readonly AbilitySoulLoadout[],
    current: readonly AbilitySoulLoadout[],
): number {
    const amount = countAbilitySoulEquipments(previous, current)
    if (amount <= 0) return 0

    if (getMissionMasterDefinition(1, 65)?.pattern === "total_ability_soul_use_count") {
        incrementPlayerCategoryMissionSync(playerId, 1, 65, amount)
    }
    for (const missionId of ABILITY_SOUL_DEGREE_MISSION_IDS) {
        if (isAbilitySoulDefinitionSupported(missionId)) {
            incrementPlayerCategoryMissionSync(playerId, 5, missionId, amount)
        }
    }
    return amount
}

function validMissionIds(kind: DegreeOperationKind): readonly number[] {
    return RULES[kind].filter(missionId => (
        Number(getMissionMasterDefinition(5, missionId)?.row[3]) === EXPECTED_TYPE[kind]
    ))
}

export function getDegreeOperationRuleCount(): number {
    return validMissionIds("treasure_mana").length
        + validMissionIds("equipment_upgrade").length
        + ABILITY_SOUL_DEGREE_MISSION_IDS.filter(isAbilitySoulDefinitionSupported).length
}

export function getDegreeOperationMissionIds(): readonly number[] {
    return Object.freeze([
        ...validMissionIds("treasure_mana"),
        ...validMissionIds("equipment_upgrade"),
        ...ABILITY_SOUL_DEGREE_MISSION_IDS.filter(isAbilitySoulDefinitionSupported),
    ].sort((left, right) => left - right))
}

export function recordMissionOperationFactsSync(
    playerId: number,
    kind: DegreeOperationKind,
    amount: number,
): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    for (const missionId of validMissionIds(kind)) {
        incrementPlayerCategoryMissionSync(playerId, 5, missionId, amount)
    }
    const regularRule = REGULAR_RULES[kind]
    if (getMissionMasterDefinition(1, regularRule.missionId)?.pattern === regularRule.pattern) {
        incrementPlayerCategoryMissionSync(playerId, 1, regularRule.missionId, amount)
    }
}

export const recordDegreeOperationFactsSync = recordMissionOperationFactsSync
