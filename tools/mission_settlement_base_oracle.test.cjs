"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const BASE_COMMIT = "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32"
const fixture = require("./fixtures/mission-settlement-pipeline-base.json")
const generatorPath = path.join(
    projectRoot,
    "tools",
    "oracle",
    "generate_mission_settlement_base.cjs",
)

test("fixed BASE settlement collector reproduces the complete fixture", () => {
    const generated = spawnSync(process.execPath, [generatorPath], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 60_000,
    })

    assert.equal(generated.status, 0, generated.stderr || generated.stdout)
    const evidence = JSON.parse(generated.stdout)
    assert.equal(evidence.runtimeCommit, BASE_COMMIT)
    assert.deepEqual(evidence, fixture)
    assert.ok(Object.values(evidence.passReward.firstResponse.passCardPoints)
        .some(points => points > 0))
    assert.deepEqual(evidence.eventScope.persisted, {})
    assert.equal(evidence.outerTransactionRollback.rolledBack, true)
    assert.match(evidence.outerTransactionRollback.injectedError, /injected BASE stage failure/)
    assert.equal("prepare" in evidence.outerTransactionRollback, false)
    assert.equal("evaluate" in evidence.outerTransactionRollback, false)
    assert.equal("settle" in evidence.outerTransactionRollback, false)
    assert.equal("reward" in evidence.outerTransactionRollback, false)

    const spoofed = spawnSync(process.execPath, [generatorPath, "deadbeef"], {
        cwd: projectRoot,
        encoding: "utf8",
    })
    assert.notEqual(spoofed.status, 0)
    assert.match(spoofed.stderr, /does not accept arguments/)
})
