import {
    completePlayerCollectMissionFactSync,
    recordPlayerCollectMissionLoginDaySync,
} from "../../data/domains/collect_mission_entry_facts"
import {
    getMissionCatalog,
    isMissionMasterDefinitionEnabledAt,
    type MissionMasterDefinition,
} from "./mission-catalog"
import { getEventLoginNaturalDay } from "./event-entry-facts"

/** Collect-table condition 0: distinct login days inside the mission's own event window. */
export const COLLECT_EVENT_LOGIN_CONDITION_TYPE = 0
/** Collect-table condition 88 (player_history_check): view one's own profile. */
export const COLLECT_PROFILE_VIEW_CONDITION_TYPE = 88

function enabledCollectMissionsByCondition(
    conditionType: number,
    evaluationTime: Date,
): readonly MissionMasterDefinition[] {
    const catalog = getMissionCatalog()
    const definitions: MissionMasterDefinition[] = []
    for (const definition of catalog.getDefinitions(4)) {
        if (Number(definition.row[4]) !== conditionType) continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue
        definitions.push(definition)
    }
    return definitions
}

/**
 * Counts the login day for every enabled collect-table window-login
 * mission, the event-table 1225 mechanism generalized by event: the
 * mission's own enable window and event scope gate the write, the
 * natural-day guard dedups repeat logins. Returns the missions that
 * counted a new day.
 */
export function recordCollectLoginMissionFactsSync(
    playerId: number,
    evaluationTime: Date,
): readonly number[] {
    const naturalDay = getEventLoginNaturalDay(evaluationTime)
    if (naturalDay === undefined) return []
    const matchedMissionIds: number[] = []
    for (const definition of enabledCollectMissionsByCondition(
        COLLECT_EVENT_LOGIN_CONDITION_TYPE,
        evaluationTime,
    )) {
        if (recordPlayerCollectMissionLoginDaySync(
            playerId,
            definition.missionId,
            naturalDay,
        )) matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Records the profile-view fact for every enabled condition-88 collect
 * mission. The client reports nothing for player_history_check (its
 * mission/update_mission_progress whitelist covers only the five degree
 * client-progress patterns); the only server-visible view signal is the
 * profile/get_my_profile request the client sends ahead of its own-profile
 * scenes (ProfileGetMyProfileLoadingTask; the follow-flow task reuses the
 * same request), so the endpoint hooks the fact here.
 */
export function recordCollectProfileViewMissionFactsSync(
    playerId: number,
    evaluationTime: Date,
): readonly number[] {
    const matchedMissionIds: number[] = []
    for (const definition of enabledCollectMissionsByCondition(
        COLLECT_PROFILE_VIEW_CONDITION_TYPE,
        evaluationTime,
    )) {
        if (completePlayerCollectMissionFactSync(playerId, definition.missionId)) {
            matchedMissionIds.push(definition.missionId)
        }
    }
    return matchedMissionIds
}
