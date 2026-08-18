"use strict"

const PROFILE_DEFINITIONS = Object.freeze({
    New: Object.freeze({ name: "new-account", profile: "New" }),
    Small: Object.freeze({ name: "normal-progress", profile: "Small", scale: 3 }),
    Large: Object.freeze({ name: "high-completion-volume", profile: "Large", scale: 20 }),
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
    const { SCENARIOS } = require("../mission_settlement_scenarios.cjs")
    if (!SCENARIOS.some(scenario => scenario.name === name)) {
        throw new Error(`active mission fixture is missing ${name}`)
    }
    return SCENARIOS.find(scenario => scenario.name === name)
}

module.exports = {
    PROFILE_DEFINITIONS,
    describeActiveMissionFixture,
    normalizeActiveMissionScenario,
    selectActiveMissionFixture,
}
