"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const reference = require("./__snapshots__/mission_entry_layered_load_reference.json")
const layeredLoad = require("./mission_entry_layered_load.cjs")
const { evaluateReport } = layeredLoad

const projectRoot = path.resolve(__dirname, "../..")
const BASE_COMMIT = "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32"
const generatorPath = path.join(
    projectRoot,
    "tools",
    "oracle",
    "generate_mission_entry_load_base.cjs",
)

test("fixed BASE load collector reproduces the structural reference", () => {
    const generated = spawnSync(process.execPath, [generatorPath], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 60_000,
    })

    assert.equal(generated.status, 0, generated.stderr || generated.stdout)
    const evidence = JSON.parse(generated.stdout)
    assert.equal(evidence.runtimeCommit, BASE_COMMIT)
    assert.deepEqual(evidence, reference)

    const spoofed = spawnSync(process.execPath, [generatorPath, "deadbeef"], {
        cwd: projectRoot,
        encoding: "utf8",
    })
    assert.notEqual(spoofed.status, 0)
    assert.match(spoofed.stderr, /does not accept arguments/)
})

test("HEAD comparison rejects a reference without the fixed BASE runtime", () => {
    assert.equal("createReference" in layeredLoad, false)
    assert.throws(
        () => evaluateReport({ steps: [] }, {
            ...reference,
            runtimeCommit: "1805192764d422ac0cff14772f798525e02a92ed",
        }),
        /fixed BASE runtime/i,
    )
})
