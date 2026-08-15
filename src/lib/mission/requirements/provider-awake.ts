import {
    getAwakeMissionRuleFamilies,
    type AwakeMissionRuleFamily,
} from "../awake-rule-catalog"
import type { MissionCatalog, MissionMasterDefinition } from "../mission-catalog"
import { bundledMissionContentRepository } from "../mission-catalog-source"
import { matchesCurrentMissionComputerDefinition } from "./computer-compatibility"
import type { MissionFactRequirementDraft } from "./types"

const familyViewByCatalog = new WeakMap<MissionCatalog, ReadonlyMap<number, AwakeMissionRuleFamily>>()

function getFamilyView(catalog: MissionCatalog): ReadonlyMap<number, AwakeMissionRuleFamily> {
    const cached = familyViewByCatalog.get(catalog)
    if (cached) return cached
    const familyByMissionId = new Map<number, AwakeMissionRuleFamily>()
    for (const family of getAwakeMissionRuleFamilies(bundledMissionContentRepository)) {
        for (const missionId of family.missionIds) {
            const definition = catalog.getDefinition(9, missionId)
            if (definition && matchesCurrentMissionComputerDefinition(definition)) {
                familyByMissionId.set(missionId, family)
            }
        }
    }
    familyViewByCatalog.set(catalog, familyByMissionId)
    return familyByMissionId
}

export function getAwakeRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    const family = getFamilyView(catalog).get(definition.missionId)
    if (!family || family.status === "fail-closed") {
        return {
            mode: "unsupported",
            reason: family?.reason ?? "Character Awake rule family is fail-closed.",
        }
    }

    switch (family.family) {
        case "all-complete":
            return {
                mode: "computed",
                missionDependencies: [
                    definition.missionId - 3,
                    definition.missionId - 2,
                    definition.missionId - 1,
                ].map(missionId => ({ category: 9, missionId })),
            }
        case "bond-token":
            return { mode: "computed", facts: [{ kind: "characters" }] }
        case "exact-quest-history":
            return { mode: "computed", facts: [{ kind: "questProgress", sections: [2] }] }
        case "generic-character-clear":
        case "leader-clear":
        case "leader-coop":
            return { mode: "computed", facts: [{ kind: "characterClearCounters" }] }
        case "mana-total":
            return { mode: "computed", facts: [{ kind: "player" }] }
        case "same-party-two":
            return { mode: "computed", facts: [{ kind: "partyCoClearCounters" }] }
        case "story-read":
        case "total-story-read":
            return { mode: "computed", facts: [{ kind: "questProgress", sections: [3] }] }
        case "exact-quest-atomic":
        case "leader-combo":
        case "leader-powerflip":
        case "no-death":
        case "quest-range-character":
        case "race-selector":
        case "same-party-quest":
        case "same-party-three":
            return { mode: "persisted" }
    }
}
