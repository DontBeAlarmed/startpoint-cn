import { getFactKeyId, normalizeFactKey, type FactIdSelection, type FactKey } from "./fact-key"
import type { MissionFactLoadPlan } from "./types"

type CollectedItemsFactKey = Extract<FactKey, { kind: "collectedItems" }>
type QuestProgressFactKey = Extract<FactKey, { kind: "questProgress" }>
type LocalSelection = CollectedItemsFactKey["itemIds"] | QuestProgressFactKey["sections"]

interface SelectionAccumulator {
    all: boolean
    seen: boolean
    readonly values: Set<number>
}

function createSelectionAccumulator(): SelectionAccumulator {
    return { all: false, seen: false, values: new Set() }
}

function addSelection(accumulator: SelectionAccumulator, selection: LocalSelection): void {
    accumulator.seen = true
    if (selection === "all") {
        accumulator.all = true
        return
    }
    if (accumulator.all) return
    for (const value of selection) accumulator.values.add(value)
}

function accumulatedSelection(accumulator: SelectionAccumulator): FactIdSelection {
    return accumulator.all ? "all" : [...accumulator.values]
}

function compareIds(left: readonly [string, FactKey], right: readonly [string, FactKey]): number {
    if (left[0] < right[0]) return -1
    if (left[0] > right[0]) return 1
    return 0
}

export function buildFactLoadPlan(keys: readonly FactKey[]): MissionFactLoadPlan {
    const normalizedById = new Map<string, FactKey>()
    const collectedItems = createSelectionAccumulator()
    const questProgress = createSelectionAccumulator()
    const categoryMissionProgress = new Map<number, SelectionAccumulator>()

    for (const key of keys) {
        const normalized = normalizeFactKey(key)
        switch (normalized.kind) {
            case "collectedItems":
                addSelection(collectedItems, normalized.itemIds)
                continue
            case "questProgress":
                addSelection(questProgress, normalized.sections)
                continue
            case "categoryMissionProgress": {
                const accumulator = categoryMissionProgress.get(normalized.category)
                    ?? createSelectionAccumulator()
                addSelection(accumulator, normalized.missionIds)
                categoryMissionProgress.set(normalized.category, accumulator)
                continue
            }
            default:
                normalizedById.set(getFactKeyId(normalized), normalized)
        }
    }

    if (collectedItems.seen) {
        const key = normalizeFactKey({
            kind: "collectedItems",
            itemIds: accumulatedSelection(collectedItems),
        })
        normalizedById.set(getFactKeyId(key), key)
    }
    if (questProgress.seen) {
        const key = normalizeFactKey({
            kind: "questProgress",
            sections: accumulatedSelection(questProgress),
        })
        normalizedById.set(getFactKeyId(key), key)
    }
    for (const [category, accumulator] of categoryMissionProgress) {
        const missionIds = accumulatedSelection(accumulator)
        if (missionIds === "all") throw new TypeError("categoryMissionProgress cannot load all missions")
        const key = normalizeFactKey({ kind: "categoryMissionProgress", category, missionIds })
        normalizedById.set(getFactKeyId(key), key)
    }

    const entries = [...normalizedById.entries()].sort(compareIds)
    const planKeys = Object.freeze(entries.map(([, key]) => key))
    const keyIds = Object.freeze(entries.map(([keyId]) => keyId))
    return Object.freeze({ keys: planKeys, keyIds })
}
