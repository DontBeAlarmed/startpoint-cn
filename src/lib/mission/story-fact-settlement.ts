import { settleMissionCategories, type MissionSettlementResult } from "./settlement"
import { MissionMasterDefinition, getMissionCatalog } from "./mission-catalog"
import { getRegularQuestMissionIdsBySection } from "./regular-quest-facts"
import { getDegreeMissionFactRequirements } from "./degree-context-requirements"
import { QuestCategory } from "../types"

const regularCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()
const degreeCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()
const mainChapterDegreeCandidateCache = new WeakMap<readonly MissionMasterDefinition[], readonly number[]>()

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
    const regularDefinitions = getMissionCatalog().getDefinitions(1)
    const degreeDefinitions = getMissionCatalog().getDefinitions(5)
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

/**
 * Main-story first clears advance the category 1 ledger: pinned-quest and
 * chapter missions whose quest rules read the MAIN section, plus the degree
 * chapter-complete family that derives from main and EX finished state.
 * Settling here keeps progress, stage claims, and rewards in the same
 * transaction and response as the story clear itself.
 */
export function settleMainStoryFactMissions(
    playerId: number,
    evaluationTime: Date,
): MissionSettlementResult {
    const catalog = getMissionCatalog()
    const regularMissionIds = getRegularQuestMissionIdsBySection(QuestCategory.MAIN, catalog)
    const degreeMissionIds = selectCached(
        catalog.getDefinitions(5),
        mainChapterDegreeCandidateCache,
        definition => getDegreeMissionFactRequirements(definition, catalog)
            ?.factFamilies.includes("episodeChapters") === true,
    )
    return settleMissionCategories(playerId, [
        ...(regularMissionIds.length > 0 ? [{ category: 1, missionIds: regularMissionIds }] : []),
        ...(degreeMissionIds.length > 0 ? [{ category: 5, missionIds: degreeMissionIds }] : []),
    ], evaluationTime)
}
