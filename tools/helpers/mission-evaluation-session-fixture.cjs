"use strict"

const { MissionEvaluationSession } = require("../../src/lib/mission")

const CATALOG = Object.freeze({ name: "catalog" })

function requirement(facts, options = {}) {
    return Object.freeze({
        mode: options.mode ?? "computed",
        facts: Object.freeze(facts),
        missionDependencies: Object.freeze(options.missionDependencies ?? []),
    })
}

function requirementRegistry(entries) {
    const byId = new Map(entries.map(entry => [
        `${entry.category}:${entry.missionId}`,
        entry.requirement,
    ]))
    return Object.freeze({
        size: entries.length,
        entries: Object.freeze(entries),
        getRequirement(category, missionId) {
            return byId.get(`${category}:${missionId}`)
        },
        getMissionsForFact() {
            return []
        },
    })
}

function createSession(facts, loaders, options = {}) {
    const ref = Object.freeze({ category: 1, missionId: 10 })
    const registry = requirementRegistry([{
        ...ref,
        requirement: requirement(facts, options.requirementOptions),
    }])
    return new MissionEvaluationSession({
        playerId: options.playerId ?? 77,
        evaluationTime: options.evaluationTime ?? new Date("2024-08-14T12:00:00.000Z"),
        catalog: options.catalog ?? CATALOG,
        requirementRegistry: registry,
        candidates: [ref],
        loaders,
        observer: options.observer,
    })
}

module.exports = {
    CATALOG,
    createSession,
    requirement,
    requirementRegistry,
}
