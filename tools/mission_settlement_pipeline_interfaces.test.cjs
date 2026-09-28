"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const settlement = require("../src/lib/mission/settlement")
const mission = require("../src/lib/mission")
const prepare = require("../src/lib/mission/settlement-prepare")
const evaluate = require("../src/lib/mission/settlement-evaluate")
const write = require("../src/lib/mission/settlement-write")

test("mission settlement keeps the three-stage API internal", () => {
    for (const name of [
        "prepareMissionSettlement",
        "evaluateMissionCandidates",
        "settleMissionEvaluation",
    ]) {
        assert.equal(name in settlement, false)
        assert.equal(name in mission, false)
    }
    assert.equal(typeof prepare.prepareMissionSettlement, "function")
    assert.equal(typeof evaluate.evaluateMissionCandidates, "function")
    assert.equal(typeof write.settleMissionEvaluation, "function")
})
