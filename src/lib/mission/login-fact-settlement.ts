import {
    getMissionMasterDefinitions,
    type MissionMasterDefinition,
} from "./master-data"
import { settleMissionCategories, type MissionSettlementResult } from "./settlement"

const regularCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()
const degreeCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()
const passCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()

function selectCached(
    definitions: readonly MissionMasterDefinition[],
    cache: WeakMap<readonly MissionMasterDefinition[], readonly number[]>,
    predicate: (definition: MissionMasterDefinition) => boolean,
): readonly number[] {
    const cached = cache.get(definitions)
    if (cached) return cached
    const missionIds = Object.freeze(definitions
        .filter(predicate)
        .map(definition => definition.missionId))
    cache.set(definitions, missionIds)
    return missionIds
}

function getRegularLoginMissionIds(): number[] {
    return [...selectCached(
        getMissionMasterDefinitions(1),
        regularCandidateCache,
        definition => definition.pattern === "total_login"
            || definition.pattern === "special_total_login_2anv",
    )]
}

function getDegreeLoginMissionIds(): number[] {
    return [...selectCached(
        getMissionMasterDefinitions(5),
        degreeCandidateCache,
        definition => definition.pattern.startsWith("degree_login_count_"),
    )]
}

function getPassLoginMissionIds(): number[] {
    return [...selectCached(
        getMissionMasterDefinitions(8),
        passCandidateCache,
        definition => definition.patternType === 0,
    )]
}

export function settleLoginFactMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    return settleMissionCategories(playerId, [
        { category: 1, missionIds: getRegularLoginMissionIds() },
        { category: 5, missionIds: getDegreeLoginMissionIds() },
        { category: 8, missionIds: getPassLoginMissionIds() },
    ], evaluationTime)
}
