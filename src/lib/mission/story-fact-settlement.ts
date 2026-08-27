import {
    getMissionMasterDefinitions,
    type MissionMasterDefinition,
} from "./master-data"
import { settleMissionCategories, type MissionSettlementResult } from "./settlement"

const regularCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()
const degreeCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()

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

export function settleCharacterStoryFactMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const regularDefinitions = getMissionMasterDefinitions(1)
    const degreeDefinitions = getMissionMasterDefinitions(5)
    return settleMissionCategories(playerId, [
        {
            category: 1,
            missionIds: selectCached(
                regularDefinitions,
                regularCandidateCache,
                definition => definition.pattern === "clear_episode",
            ),
        },
        {
            category: 5,
            missionIds: selectCached(
                degreeDefinitions,
                degreeCandidateCache,
                definition => definition.pattern.startsWith("degree_character_episode_read_"),
            ),
        },
    ], evaluationTime)
}
