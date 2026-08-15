"use strict"

require("ts-node/register/transpile-only")

const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
} = require("../../src/lib/mission")

const fact = Object.freeze({ kind: "player" })
const requirement = Object.freeze({
    mode: "computed",
    facts: Object.freeze([fact]),
    missionDependencies: Object.freeze([]),
})
const requirementRegistry = Object.freeze({
    size: 1,
    entries: Object.freeze([]),
    getRequirement: () => requirement,
    getMissionsForFact: () => [],
})
const loaders = new MissionFactLoaderRegistry()
loaders.register("player", () => Promise.reject(new Error("expected rejection")))
const session = new MissionEvaluationSession({
    playerId: 77,
    evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    catalog: Object.freeze({}),
    requirementRegistry,
    candidates: Object.freeze([{ category: 1, missionId: 10 }]),
    loaders,
})

try {
    session.getFact(fact)
    throw new Error("expected synchronous rejection")
} catch (error) {
    if (!/must be synchronous/i.test(String(error))) throw error
}

setImmediate(() => {
    process.stdout.write("rejected Promise consumed\n")
})
