"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
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

test("architecture status records Stage 5 and completed performance while keeping final review pending", () => {
    const architecture = fs.readFileSync(path.join(
        __dirname,
        "..",
        "docs",
        "systems",
        "mission-engine-architecture.md",
    ), "utf8")
    const stage5 = architecture.match(/### 阶段 5：[\s\S]*?(?=### 阶段 6：)/)?.[0]
    const stage6 = architecture.match(/### 阶段 6：[\s\S]*?(?=## 验收指标)/)?.[0]

    assert.match(stage5, /状态：已实施。/)
    assert.doesNotMatch(stage5, /待阶段 4 完成后实施/)
    assert.match(stage6, /状态：第 13、14 项已实施；第 15 项最终全量回归与最终双审待执行/)
    assert.match(stage6, /任务引擎整体状态暂不宣告完成/)
    assert.doesNotMatch(stage6, /将本文状态从“设计”改为“已实现”/)
})
