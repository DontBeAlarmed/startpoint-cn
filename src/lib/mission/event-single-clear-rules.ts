import { getQuestContentTableSync } from "../assets"
import { getMissionMasterDefinitions } from "./master-data"

export interface ExactEventSingleClearRule {
    readonly missionId: number
    readonly categories: readonly number[]
    readonly questIds: "all" | readonly number[]
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

const EXACT_SINGLE_CLEAR_MISSION_IDS = new Set([
    1213, 1214, 1215, 1221, 1222, 1300, 1303, 1304,
])

function parsePositiveIntegerList(value: unknown): number[] | null {
    if (typeof value !== "string" || value === "" || value === "(None)") return null
    const values = value.split(",").map(Number)
    return values.length > 0 && values.every((entry, index) => (
        Number.isSafeInteger(entry)
        && entry > 0
        && (index === 0 || entry > values[index - 1])
    )) ? values : null
}

function buildExactEventSingleClearRules(): readonly ExactEventSingleClearRule[] {
    const rules: ExactEventSingleClearRule[] = []
    const challengeDungeonQuests = getQuestContentTableSync(
        "challenge_dungeon_event_quest.json",
    )
    for (const definition of getMissionMasterDefinitions(3)) {
        if (!EXACT_SINGLE_CLEAR_MISSION_IDS.has(definition.missionId)
            || Number(definition.row[2]) !== 14
            || definition.row[11] !== "(None)") continue

        const questRangeKind = Number(definition.row[7])
        if ((questRangeKind === 1 || questRangeKind === 12)
            && definition.row[8] === ""
            && definition.row[10] === "") {
            rules.push({
                missionId: definition.missionId,
                categories: questRangeKind === 1 ? [4] : [6, 13, 14, 20],
                questIds: "all",
                definition,
            })
            continue
        }

        if (questRangeKind !== 7) continue
        const eventId = Number(definition.row[8])
        const suffixes = parsePositiveIntegerList(definition.row[10])
        if (!Number.isSafeInteger(eventId) || eventId <= 0 || suffixes === null) continue
        const questIds = suffixes.map(suffix => eventId * 1000 + suffix)
        if (questIds.some(questId => (
            challengeDungeonQuests as Record<string, unknown>
        )[String(questId)] === undefined)) continue
        rules.push({
            missionId: definition.missionId,
            categories: [13],
            questIds,
            definition,
        })
    }
    return Object.freeze(rules)
}

export function getExactEventSingleClearRules(): readonly ExactEventSingleClearRule[] {
    return buildExactEventSingleClearRules()
}
