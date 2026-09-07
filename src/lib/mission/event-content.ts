import type { MissionCatalog } from "./mission-catalog"
import { getMissionCatalogContentTable } from "./mission-catalog"

export interface EventQuestMapping {
    readonly countMode?: unknown
    readonly categories?: readonly number[]
    readonly questIds?: readonly number[]
}

type EventQuestMap = Readonly<Record<string, unknown>>
type EventMissionRewardTable = Readonly<Record<string, unknown>>

export function getEventQuestMapping(
    catalog: MissionCatalog,
    pattern: string,
): EventQuestMapping | undefined {
    const value = getMissionCatalogContentTable<EventQuestMap>(catalog, "mission_event_quest_map.json")[pattern]
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const categories = Array.isArray(raw.categories)
        && raw.categories.every(entry => Number.isSafeInteger(entry) && entry > 0)
        ? raw.categories as number[]
        : undefined
    const questIds = Array.isArray(raw.questIds)
        && raw.questIds.every(entry => Number.isSafeInteger(entry) && entry > 0)
        ? raw.questIds as number[]
        : undefined
    return Object.freeze({ countMode: raw.countMode, categories, questIds })
}

export function getEventBattleRuleAsset(catalog: MissionCatalog): unknown {
    return getMissionCatalogContentTable<unknown>(catalog, "mission_event_battle_rules.json")
}

export function getEventMissionRewardTable(catalog: MissionCatalog): EventMissionRewardTable {
    return getMissionCatalogContentTable<EventMissionRewardTable>(catalog, "mission_event_reward.json")
}
