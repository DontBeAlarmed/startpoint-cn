"use strict"

const { SCENARIOS } = require("../mission_settlement_scenarios.cjs")

const SCENARIO_BY_NAME = new Map(SCENARIOS.map(scenario => [scenario.name, scenario]))

function createProfileDefinition(profile, name) {
    const scenario = SCENARIO_BY_NAME.get(name)
    if (!scenario || !Number.isSafeInteger(scenario.scale) || scenario.scale < 0) {
        throw new Error(`active mission fixture is missing valid scale metadata for ${name}`)
    }
    return Object.freeze({ name, profile, scale: scenario.scale })
}

const PROFILE_DEFINITIONS = Object.freeze({
    New: createProfileDefinition("New", "new-account"),
    Small: createProfileDefinition("Small", "normal-progress"),
    Large: createProfileDefinition("Large", "high-completion-volume"),
})
const PROFILE_BY_NAME = new Map(
    Object.values(PROFILE_DEFINITIONS).map(definition => [definition.name, definition.profile]),
)

function normalizeActiveMissionScenario(value) {
    if (typeof value !== "string") {
        throw new TypeError("active mission scenario must be a string")
    }
    const profile = PROFILE_DEFINITIONS[value[0]?.toUpperCase() + value.slice(1).toLowerCase()]
        ? value[0].toUpperCase() + value.slice(1).toLowerCase()
        : PROFILE_BY_NAME.get(value)
    if (!profile || !PROFILE_DEFINITIONS[profile]) {
        throw new RangeError(`unknown active mission scenario: ${value}`)
    }
    return PROFILE_DEFINITIONS[profile].name
}

function describeActiveMissionFixture(value) {
    const name = normalizeActiveMissionScenario(value)
    const profile = PROFILE_BY_NAME.get(name)
    return Object.freeze({ ...PROFILE_DEFINITIONS[profile] })
}

function selectActiveMissionFixture(value) {
    const name = normalizeActiveMissionScenario(value)
    return SCENARIO_BY_NAME.get(name)
}

module.exports = {
    PROFILE_DEFINITIONS,
    describeActiveMissionFixture,
    normalizeActiveMissionScenario,
    selectActiveMissionFixture,
}
