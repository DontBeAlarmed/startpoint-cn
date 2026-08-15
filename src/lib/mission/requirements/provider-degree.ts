import type { FactKey } from "../facts/fact-key"
import type { MissionCatalog, MissionMasterDefinition } from "../mission-catalog"
import {
    getDegreeMissionFactRequirements,
    type DegreeContextFactFamily,
} from "../degree-context-requirements"
import type { MissionFactRequirementDraft } from "./types"

const AUTHORITATIVE_CHARACTER_LEVEL_TARGETS: Readonly<Record<number, number>> = Object.freeze({
    3010: 80,
    3020: 100,
})

function familyFacts(family: DegreeContextFactFamily): readonly FactKey[] {
    switch (family) {
        case "player":
            return [{ kind: "player" }]
        case "characters":
            return [{ kind: "characters" }]
        case "manaNodes":
            return [{ kind: "characterManaNodes" }]
        case "missionBattleCounters":
            return [{ kind: "missionBattleCounters" }]
        case "degreeBattleStats":
            return [{ kind: "degreeBattleStats" }]
        case "episodeClearCount":
            return [{ kind: "questProgress", sections: [3] }]
        case "episodeChapters":
            return [
                { kind: "questProgress", sections: [1] },
                { kind: "questProgress", sections: [4] },
            ]
        case "practiceRanks":
            return [{ kind: "questProgress", sections: [15] }]
        case "treasureShop":
            return [{ kind: "shopPurchases", shopType: 2 }]
        case "craftPoint":
            return [{ kind: "collectedItems", itemIds: "all" }]
        case "collectedItems":
        case "equipment":
            return family === "equipment" ? [{ kind: "equipment" }] : []
    }
}

export function getDegreeRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    const authoritativeTarget = AUTHORITATIVE_CHARACTER_LEVEL_TARGETS[definition.missionId]
    if (authoritativeTarget !== undefined) {
        const stage = catalog.getRewardStage(5, definition.missionId, 1)
        if (stage?.targetProgress !== authoritativeTarget) {
            return {
                mode: "unsupported",
                reason: "Authoritative Degree character level reward stage is invalid.",
            }
        }
    }
    const requirements = getDegreeMissionFactRequirements(definition, catalog)
    if (!requirements) {
        return {
            mode: "unsupported",
            reason: "No authoritative Degree fact mapping is available.",
        }
    }

    const facts = requirements.factFamilies.flatMap(familyFacts)
    if (requirements.collectedItemId !== undefined) {
        facts.push({ kind: "collectedItems", itemIds: [requirements.collectedItemId] })
    }
    if (requirements.finishedQuestSection !== undefined) {
        facts.push({ kind: "questProgress", sections: [requirements.finishedQuestSection] })
    }

    return facts.length === 0
        ? { mode: "persisted" }
        : { mode: "computed", facts }
}
