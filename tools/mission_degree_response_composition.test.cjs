"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    composeMissionSettlementResponse,
    mergeMissionDegreeList,
} = require("../src/lib/mission/response-fragment")

test("Degree composition keeps first positions, deduplicates, and writes viewer_id entries", () => {
    const data = {
        degree_list: [{ viewer_id: 7, degree_id: 30 }],
        user_info: { degree_id: 500 },
    }

    mergeMissionDegreeList(data, [30, 31, 31], 99)
    mergeMissionDegreeList(data, [32, 31], 100)

    assert.deepEqual(data.degree_list, [
        { viewer_id: 99, degree_id: 30 },
        { viewer_id: 100, degree_id: 31 },
        { viewer_id: 100, degree_id: 32 },
    ])
    assert.deepEqual(data.user_info, { degree_id: 500 })
})

test("login then event-login composition preserves Common mission order and Degree first position", () => {
    const data = { mission_info: [], degree_list: [] }
    composeMissionSettlementResponse(data, {
        common: { mission_info: [{ mission_id: "login" }] },
        degreeIds: [10],
    }, 800)
    composeMissionSettlementResponse(data, {
        common: { mission_info: [{ mission_id: "event-login" }] },
        degreeIds: [11, 10],
    }, 800)

    assert.deepEqual(data.mission_info, [
        { mission_id: "login" },
        { mission_id: "event-login" },
    ])
    assert.deepEqual(data.degree_list, [
        { viewer_id: 800, degree_id: 10 },
        { viewer_id: 800, degree_id: 11 },
    ])
})

console.log("mission degree response composition tests passed")
