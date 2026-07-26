import { deepFreeze } from "../deep-freeze"
import {
    ContentAssetAuditError,
    type ContentAssetAuditSourcePair,
} from "./types"

function isOwnedRelativePath(value: string): boolean {
    if (value.length === 0
        || value.startsWith("/")
        || value.includes("\\")
        || /[\u0000-\u001f\u007f]/.test(value)) return false
    return value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")
}

export function validateAssetAuditSourceRegistry(
    pairs: readonly ContentAssetAuditSourcePair[],
): void {
    const runtimeTables = new Set<string>()
    for (const pair of pairs) {
        if (!isOwnedRelativePath(pair.sourceRelativePath)
            || !isOwnedRelativePath(pair.runtimeTable)) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_REGISTRY_PATH",
                "source and runtime paths must stay inside their owned roots",
            )
        }
        if (runtimeTables.has(pair.runtimeTable)) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_REGISTRY_DUPLICATE",
                `duplicate runtime table: ${pair.runtimeTable}`,
                pair.runtimeTable,
            )
        }
        runtimeTables.add(pair.runtimeTable)
    }
}

const sourcePairs: ContentAssetAuditSourcePair[] = [
    { sourceRelativePath: "mission/regular_mission.json", runtimeTable: "mission_regular.json" },
    { sourceRelativePath: "mission/regular_mission_reward.json", runtimeTable: "mission_regular_reward.json" },
    { sourceRelativePath: "mission/daily_mission.json", runtimeTable: "mission_daily.json" },
    { sourceRelativePath: "mission/daily_mission_reward.json", runtimeTable: "mission_daily_reward.json" },
    { sourceRelativePath: "mission/weekly_mission.json", runtimeTable: "mission_weekly_def.json" },
    { sourceRelativePath: "mission/weekly_mission_reward.json", runtimeTable: "mission_weekly_reward.json" },
    { sourceRelativePath: "mission/degree_mission.json", runtimeTable: "mission_degree.json" },
    { sourceRelativePath: "mission/degree_mission_reward.json", runtimeTable: "mission_degree_reward.json" },
    { sourceRelativePath: "mission/event_mission.json", runtimeTable: "mission_event.json" },
    { sourceRelativePath: "mission/event_mission_reward.json", runtimeTable: "mission_event_reward.json" },
    { sourceRelativePath: "mission/character_awake_mission.json", runtimeTable: "mission_char_awake.json" },
    { sourceRelativePath: "mission/character_awake_mission_reward.json", runtimeTable: "mission_char_awake_reward.json" },
    { sourceRelativePath: "mission/collect_item_event_mission.json", runtimeTable: "mission_collect_item.json" },
    { sourceRelativePath: "mission/collect_item_event_mission_reward.json", runtimeTable: "mission_collect_item_reward.json" },
    { sourceRelativePath: "active_mission/active_mission.json", runtimeTable: "mission_active.json" },
    { sourceRelativePath: "active_mission/active_mission_event.json", runtimeTable: "mission_active_event.json" },
    { sourceRelativePath: "active_mission/active_mission_reward.json", runtimeTable: "mission_active_reward.json" },
    { sourceRelativePath: "pass_card/pass_card_daily_mission.json", runtimeTable: "mission_pass_daily.json" },
    { sourceRelativePath: "pass_card/pass_card_daily_mission_reward.json", runtimeTable: "mission_pass_daily_reward.json" },
    { sourceRelativePath: "pass_card/pass_card_week_mission.json", runtimeTable: "mission_pass_week.json" },
    { sourceRelativePath: "pass_card/pass_card_week_mission_reward.json", runtimeTable: "mission_pass_week_reward.json" },
    { sourceRelativePath: "pass_card/pass_card_event_mission.json", runtimeTable: "mission_pass_event.json" },
    { sourceRelativePath: "pass_card/pass_card_event_mission_reward.json", runtimeTable: "mission_pass_event_reward.json" },
    { sourceRelativePath: "pass_card/pass_card_event.json", runtimeTable: "pass_card_event.json" },
    { sourceRelativePath: "pass_card/pass_card_reward.json", runtimeTable: "pass_card_reward.json" },
]

validateAssetAuditSourceRegistry(sourcePairs)

export const ASSET_AUDIT_SOURCE_PAIRS: readonly ContentAssetAuditSourcePair[] = deepFreeze(sourcePairs)
