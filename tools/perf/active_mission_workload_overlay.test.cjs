"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    assignActiveMissionScale,
    createActiveMissionBehaviorSummary,
} = require("./active-mission/workload-overlay.cjs")
const {
    describeActiveMissionFixture,
} = require("./active-mission/fixture.cjs")
const { seedActiveMissionState } = require("./active-mission/workload-overlay.cjs")

function createIdentities(entryName, count) {
    return Array.from({ length: count }, (_, identityIndex) => ({
        entryName,
        identityIndex,
    }))
}

function assignedProfiles(identities) {
    return assignActiveMissionScale(identities)
        .map(identity => identity.activeMissionFixture.profile)
}

test("load identities cycle through the existing New, Small, and Large fixtures", () => {
    const identities = createIdentities("load", 7)

    const assigned = assignActiveMissionScale(identities)

    assert.deepEqual(assigned.map(identity => identity.activeMissionFixture), [
        describeActiveMissionFixture("New"),
        describeActiveMissionFixture("Small"),
        describeActiveMissionFixture("Large"),
        describeActiveMissionFixture("New"),
        describeActiveMissionFixture("Small"),
        describeActiveMissionFixture("Large"),
        describeActiveMissionFixture("New"),
    ])
    assert.deepEqual(identities, createIdentities("load", 7))
})

test("single-battle identities use the same stable identity-index assignment", () => {
    const first = assignedProfiles(createIdentities("single-battle", 8))
    const second = assignedProfiles(createIdentities("single-battle", 8))

    assert.deepEqual(first, ["New", "Small", "Large", "New", "Small", "Large", "New", "Small"])
    assert.deepEqual(second, first)
})

test("scale assignment does not use runtime randomness", () => {
    const originalRandom = Math.random
    Math.random = () => { throw new Error("runtime randomness is forbidden") }
    try {
        assert.deepEqual(
            assignedProfiles(createIdentities("load", 3)),
            ["New", "Small", "Large"],
        )
    } finally {
        Math.random = originalRandom
    }
})

test("load behavior summary hashes all_active_mission_list without embedding it", () => {
    const allActiveMissionList = {
        90002: { progress: 3, stages: { 1: false } },
        90001: { progress: 8, stages: [] },
    }

    const summary = createActiveMissionBehaviorSummary("load", allActiveMissionList)

    assert.equal(summary.entry, "load")
    assert.equal(summary.activeMission.unsupportedCount, 10)
    assert.match(summary.activeMission.stateHash, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(summary).includes("90001"), false)
    assert.equal(Object.hasOwn(summary.activeMission, "allActiveMissionList"), false)
    assert.equal(
        createActiveMissionBehaviorSummary("load", {
            90001: { stages: [], progress: 8 },
            90002: { stages: { 1: false }, progress: 3 },
        }).activeMission.stateHash,
        summary.activeMission.stateHash,
    )
})

test("unsupported mission progress fails closed in the workload assertion", () => {
    assert.throws(
        () => createActiveMissionBehaviorSummary("load", {
            21030: { progress: 1, stages: [] },
        }),
        /unsupported active mission 21030 must remain fail closed/,
    )
})

test("overlay seeds only load and single-battle identities", () => {
    const writes = []
    const seedProfile = (playerId, scale) => { writes.push([playerId, scale]) }
    const [load, singleBattle, story] = assignActiveMissionScale([
        { entryName: "load", identityIndex: 0, playerId: 11 },
        { entryName: "single-battle", identityIndex: 1, playerId: 12 },
        { entryName: "story", identityIndex: 2, playerId: 13 },
    ])
    seedActiveMissionState(load, seedProfile)
    seedActiveMissionState(singleBattle, seedProfile)
    seedActiveMissionState(story, seedProfile)
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0], [12, 3])
})
