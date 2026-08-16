"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    evaluateMissionProgressStageB,
    getMissionProgressStageBRefs,
} = require("../src/lib/mission/progress-stage-b")

function evaluationMission(category, missionId, dependencies) {
    return Object.freeze({
        category,
        missionId,
        declaredFactDependencies: Object.freeze(dependencies),
        dbProgress: 0,
        computedProgress: 0,
        finalProgress: 0,
        receivedStages: Object.freeze([]),
    })
}

const evaluationMissions = Object.freeze([
    evaluationMission(1, 11, [{ kind: "characters" }]),
    evaluationMission(1, 12, [{ kind: "items" }]),
    evaluationMission(4, 41, [{ kind: "collectedItems", itemIds: [9001] }]),
])

const registry = Object.freeze({
    getMissionsForFact(key) {
        if (key.kind === "characters") return [{ category: 1, missionId: 11 }]
        if (key.kind === "items") return [{ category: 1, missionId: 12 }, { category: 99, missionId: 9901 }]
        if (key.kind === "collectedItems") return [{ category: 4, missionId: 41 }]
        return []
    },
})

test("no invalidated facts create no Stage B candidates", () => {
    assert.deepEqual(
        getMissionProgressStageBRefs(evaluationMissions, [], registry),
        [],
    )
})

test("no invalidated facts return before constructing a Stage B Session", () => {
    assert.equal(evaluateMissionProgressStageB({
        prepared: {},
        evaluation: { missions: evaluationMissions },
        invalidatedFactKeys: [],
        settlement: {},
    }), null)
})

test("Stage B is the deduplicated intersection of reverse-index hits and Stage A missions", () => {
    const refs = getMissionProgressStageBRefs(
        evaluationMissions,
        [
            { kind: "items" },
            { kind: "items" },
            { kind: "characters" },
        ],
        registry,
    )

    assert.deepEqual(refs, [
        { category: 1, missionId: 11 },
        { category: 1, missionId: 12 },
    ])
})

test("Stage B does not expand beyond the requested Stage A mission set", () => {
    assert.deepEqual(
        getMissionProgressStageBRefs(
            evaluationMissions,
            [{ kind: "items" }],
            registry,
        ),
        [{ category: 1, missionId: 12 }],
    )
})

test("Stage B rejects stale reverse-index hits that do not match Stage A declarations", () => {
    const staleRegistry = Object.freeze({
        getMissionsForFact: () => [{ category: 1, missionId: 11 }],
    })

    assert.deepEqual(
        getMissionProgressStageBRefs(
            evaluationMissions,
            [{ kind: "equipment" }],
            staleRegistry,
        ),
        [],
    )
})

test("Stage B keeps reverse-index hits whose normalized selections intersect", () => {
    const selectionMissions = Object.freeze([
        evaluationMission(4, 41, [{ kind: "collectedItems", itemIds: [9002, 9001] }]),
    ])
    const selectionRegistry = Object.freeze({
        getMissionsForFact: () => [{ category: 4, missionId: 41 }],
    })

    assert.deepEqual(
        getMissionProgressStageBRefs(
            selectionMissions,
            [{ kind: "collectedItems", itemIds: [9001] }],
            selectionRegistry,
        ),
        [{ category: 4, missionId: 41 }],
    )
    assert.deepEqual(
        getMissionProgressStageBRefs(
            selectionMissions,
            [{ kind: "collectedItems", itemIds: [9003] }],
            selectionRegistry,
        ),
        [],
    )
})
