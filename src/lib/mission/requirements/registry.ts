import { buildFactLoadPlan } from "../facts/load-plan"
import { getFactKeyId, normalizeFactKey, type FactKey } from "../facts/fact-key"
import { getMissionCatalog, type MissionCatalog } from "../mission-catalog"
import type {
    MissionFactRequirement,
    MissionFactRequirementDraft,
    MissionFactRequirementEntry,
    MissionFactRequirementRegistry,
    MissionRef,
} from "./types"

const EMPTY_REFS: readonly MissionRef[] = Object.freeze([])
const registryByCatalog = new WeakMap<MissionCatalog, MissionFactRequirementRegistry>()

function missionKey(category: number, missionId: number): string {
    return `${category}:${missionId}`
}

function compareRefs(left: MissionRef, right: MissionRef): number {
    return left.category - right.category || left.missionId - right.missionId
}

function freezeDependencies(
    catalog: MissionCatalog,
    dependencies: readonly MissionRef[] | undefined,
): readonly MissionRef[] {
    const byKey = new Map<string, MissionRef>()
    for (const dependency of dependencies ?? []) {
        if (!catalog.getDefinition(dependency.category, dependency.missionId)) continue
        const ref = Object.freeze({
            category: dependency.category,
            missionId: dependency.missionId,
        })
        byKey.set(missionKey(ref.category, ref.missionId), ref)
    }
    return Object.freeze([...byKey.values()].sort(compareRefs))
}

function freezeRequirement(
    catalog: MissionCatalog,
    draft: MissionFactRequirementDraft,
): MissionFactRequirement {
    const missingDependency = draft.missionDependencies?.find(dependency => (
        catalog.getDefinition(dependency.category, dependency.missionId) === undefined
    ))
    if (missingDependency) {
        return Object.freeze({
            mode: "unsupported",
            facts: Object.freeze([]),
            missionDependencies: Object.freeze([]),
            reason: `Missing mission dependency ${missingDependency.category}:${missingDependency.missionId}.`,
        })
    }
    const facts = buildFactLoadPlan(draft.facts ?? []).keys
    const missionDependencies = freezeDependencies(catalog, draft.missionDependencies)
    return Object.freeze({
        mode: draft.mode,
        facts,
        missionDependencies,
        ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    })
}

function buildRegistry(catalog: MissionCatalog): MissionFactRequirementRegistry {
    const { getMissionRequirementDraft } = require("./providers") as typeof import("./providers")
    const requirementByMission = new Map<string, MissionFactRequirement>()
    const reverseRefs = new Map<string, MissionRef[]>()
    const entries: MissionFactRequirementEntry[] = []

    for (let category = 1; category <= 10; category++) {
        for (const definition of catalog.getDefinitions(category)) {
            const requirement = freezeRequirement(
                catalog,
                getMissionRequirementDraft(definition, catalog),
            )
            const ref = Object.freeze({ category, missionId: definition.missionId })
            const entry = Object.freeze({ ...ref, requirement })
            requirementByMission.set(missionKey(category, definition.missionId), requirement)
            entries.push(entry)
            for (const fact of requirement.facts) {
                const factId = getFactKeyId(fact)
                const refs = reverseRefs.get(factId) ?? []
                refs.push(ref)
                reverseRefs.set(factId, refs)
            }
        }
    }

    entries.sort(compareRefs)
    const reverse = new Map<string, readonly MissionRef[]>()
    for (const [factId, refs] of reverseRefs) {
        reverse.set(factId, Object.freeze(refs.sort(compareRefs)))
    }
    const frozenEntries = Object.freeze(entries)
    return Object.freeze({
        size: frozenEntries.length,
        entries: frozenEntries,
        getRequirement(category: number, missionId: number): MissionFactRequirement | undefined {
            return requirementByMission.get(missionKey(category, missionId))
        },
        getMissionsForFact(fact: FactKey): readonly MissionRef[] {
            return reverse.get(getFactKeyId(normalizeFactKey(fact))) ?? EMPTY_REFS
        },
    })
}

export function getMissionFactRequirementRegistry(
    catalog: MissionCatalog = getMissionCatalog(),
): MissionFactRequirementRegistry {
    const cached = registryByCatalog.get(catalog)
    if (cached) return cached
    const registry = buildRegistry(catalog)
    registryByCatalog.set(catalog, registry)
    return registry
}
