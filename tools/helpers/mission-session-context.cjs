// Test-only Session-backed mission computer context builder (D24 C2).
// Replaces the retired computer.buildContext legacy API for behavior tests:
// builds a real MissionEvaluationSession over production fact loaders and
// returns the Session-built CategoryContext, mirroring settlement evaluation.
const { MissionEvaluationSession } = require("../../src/lib/mission/evaluation-session")
const { getMissionCatalog } = require("../../src/lib/mission/mission-catalog")
const { createProductionMissionFactLoaderRegistry } = require("../../src/lib/mission/production-fact-loaders")
const { getMissionFactRequirementRegistry } = require("../../src/lib/mission/requirements/registry")
const { getComputer } = require("../../src/lib/mission/registry")

function buildMissionSession(playerId, category, missionIds, options = {}) {
    const catalog = getMissionCatalog(options.repository)
    const requestedIds = missionIds ?? catalog.getMissionIds(category)
    const candidateIds = [...new Set(requestedIds)]
        .filter(id => catalog.getDefinition(category, id))
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime: options.evaluationTime instanceof Date
            ? options.evaluationTime
            : new Date(),
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: candidateIds.map(missionId => ({ category, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(options.repository, options.factSeeds),
    })
    return { session, catalog, candidateIds }
}

function buildMissionComputerContext(playerId, category, missionIds, options = {}) {
    const { session, candidateIds } = buildMissionSession(playerId, category, missionIds, options)
    const computer = options.computer ?? getComputer(category)
    return computer.buildContextFromSession(session, category, candidateIds)
}

module.exports = { buildMissionSession, buildMissionComputerContext }
