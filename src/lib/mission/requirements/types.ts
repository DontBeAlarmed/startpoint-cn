import type { FactKey } from "../facts/fact-key"

export interface MissionRef {
    readonly category: number
    readonly missionId: number
}

export interface MissionFactRequirement {
    readonly mode: "computed" | "persisted" | "unsupported"
    readonly facts: readonly FactKey[]
    readonly missionDependencies: readonly MissionRef[]
    readonly reason?: string
}

export interface MissionFactRequirementEntry extends MissionRef {
    readonly requirement: MissionFactRequirement
}

export interface MissionFactRequirementRegistry {
    readonly size: number
    readonly entries: readonly MissionFactRequirementEntry[]
    readonly getRequirement: (
        category: number,
        missionId: number,
    ) => MissionFactRequirement | undefined
    readonly getMissionsForFact: (fact: FactKey) => readonly MissionRef[]
}

export interface MissionFactRequirementDraft {
    readonly mode: MissionFactRequirement["mode"]
    readonly facts?: readonly FactKey[]
    readonly missionDependencies?: readonly MissionRef[]
    readonly reason?: string
}
