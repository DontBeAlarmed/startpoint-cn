export interface ManaNodeSemanticFields {
    readonly field1: string
    readonly field5: string
    readonly field6: string
}

export interface ManaNodeEvolutionSemantics {
    readonly abilitySlotIndex: number | null
    readonly isSkillEvolutionRequisite: boolean
}

export class InvalidManaNodeSemanticsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "InvalidManaNodeSemanticsError"
    }
}

// CN ManaNodeValues maps field1 to Ability/Episode, then maps Ability field5
// to Ability/ActionSkillLevel/ActionSkillEvolution; only Ability uses field6 as its slot.
function parseAbilitySlotIndex(value: string): number {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
        throw new InvalidManaNodeSemanticsError(`ability slot index must be a non-negative integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new InvalidManaNodeSemanticsError(`ability slot index must be a safe integer: ${value}`)
    }
    return parsed
}

export function parseManaNodeEvolutionSemantics(
    fields: ManaNodeSemanticFields,
): ManaNodeEvolutionSemantics {
    if (fields.field1 === "1") {
        return { abilitySlotIndex: null, isSkillEvolutionRequisite: false }
    }
    if (fields.field1 !== "0") {
        throw new InvalidManaNodeSemanticsError(
            `field1 must identify an ability or episode node: ${fields.field1}`,
        )
    }

    switch (fields.field5) {
        case "0":
            return {
                abilitySlotIndex: parseAbilitySlotIndex(fields.field6),
                isSkillEvolutionRequisite: false,
            }
        case "1":
            return { abilitySlotIndex: null, isSkillEvolutionRequisite: false }
        case "2":
            return { abilitySlotIndex: null, isSkillEvolutionRequisite: true }
        default:
            throw new InvalidManaNodeSemanticsError(
                `field5 has an unknown ability effect kind: ${fields.field5}`,
            )
    }
}
