"use strict"

const crypto = require("node:crypto")

const {
    PROFILE_DEFINITIONS,
    describeActiveMissionFixture,
} = require("./fixture.cjs")
const {
    EXPECTED_UNSUPPORTED_MISSION_IDS,
} = require("./baseline.cjs")
const {
    seedScenarioProgress,
} = require("../mission_settlement_scenarios.cjs")

const OVERLAY_ENTRY_NAMES = new Set(["load", "single-battle"])
const ACTIVE_MISSION_FIXTURES = Object.freeze(
    Object.values(PROFILE_DEFINITIONS)
        .map(definition => describeActiveMissionFixture(definition.profile))
        .sort((left, right) => left.scale - right.scale),
)

function countUnsupportedMissionViolations(allActiveMissionList) {
    if (allActiveMissionList === null
        || typeof allActiveMissionList !== "object"
        || Array.isArray(allActiveMissionList)) {
        throw new TypeError("active mission state must be a record")
    }
    let violations = 0
    for (const missionId of EXPECTED_UNSUPPORTED_MISSION_IDS) {
        const state = allActiveMissionList[String(missionId)]
        if (state === undefined) continue
        if (state === null || typeof state !== "object" || Array.isArray(state)) {
            violations++
            continue
        }
        if (!Number.isSafeInteger(state.progress) || state.progress < 0 || state.progress > 0) {
            violations++
            continue
        }
        const stages = state.stages
        if (Array.isArray(stages) ? stages.length > 0 : stages === null
            || typeof stages !== "object" || Object.keys(stages).length > 0) {
            violations++
        }
    }
    return violations
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
        )
    }
    return value
}

function assignActiveMissionScale(identities) {
    if (!Array.isArray(identities)) throw new TypeError("identities must be an array")
    return identities.map(identity => {
        if (!OVERLAY_ENTRY_NAMES.has(identity?.entryName)) return identity
        if (!Number.isSafeInteger(identity.identityIndex) || identity.identityIndex < 0) {
            throw new TypeError("overlay identityIndex must be a non-negative safe integer")
        }
        const fixture = ACTIVE_MISSION_FIXTURES[identity.identityIndex % ACTIVE_MISSION_FIXTURES.length]
        return Object.freeze({ ...identity, activeMissionFixture: fixture })
    })
}

function createActiveMissionBehaviorSummary(entry, allActiveMissionList) {
    const unsupportedViolationCount = countUnsupportedMissionViolations(allActiveMissionList)
    if (unsupportedViolationCount > 0) {
        const missionId = EXPECTED_UNSUPPORTED_MISSION_IDS.find(id => {
            const state = allActiveMissionList[String(id)]
            return state !== undefined && (
                state === null
                || typeof state !== "object"
                || Array.isArray(state)
                || state.progress !== 0
                || (Array.isArray(state.stages)
                    ? state.stages.length > 0
                    : state.stages === null
                        || typeof state.stages !== "object"
                        || Object.keys(state.stages).length > 0)
            )
        })
        throw new Error(`unsupported active mission ${missionId} must remain fail closed`)
    }
    const stateHash = crypto.createHash("sha256")
        .update(JSON.stringify(canonicalize(allActiveMissionList ?? {})))
        .digest("hex")
    return {
        entry,
        activeMission: {
            unsupportedCount: EXPECTED_UNSUPPORTED_MISSION_IDS.length,
            unsupportedViolationCount,
            stateHash,
        },
    }
}

function seedActiveMissionState(identity, seedProfile = seedScenarioProgress) {
    if (!identity?.activeMissionFixture || !OVERLAY_ENTRY_NAMES.has(identity.entryName)) return
    if (identity.activeMissionFixture.scale === 0) return
    seedProfile(identity.playerId, identity.activeMissionFixture.scale)
}

module.exports = {
    assignActiveMissionScale,
    createActiveMissionBehaviorSummary,
    seedActiveMissionState,
}
