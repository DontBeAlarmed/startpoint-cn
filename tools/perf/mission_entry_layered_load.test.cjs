"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const reference = require("./__snapshots__/mission_entry_layered_load_reference.json")
const summary = require("./__snapshots__/mission_entry_layered_load_summary.json")
const {
    evaluateReport,
    runMissionEntryLayeredLoad,
} = require("./mission_entry_layered_load.cjs")

test("layered mission entry smoke verifies boundaries without formal admission", async () => {
    assert.equal(reference.runtimeCommit, "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32")
    const report = await runMissionEntryLayeredLoad({
        players: 4,
        concurrencies: [1],
        reference,
    })

    assert.deepEqual(report.gate, {
        reportStructureValid: true,
        zeroErrors: true,
        behaviorEquivalent: true,
        rollbackVerified: true,
        sqlComputeNonIncreasing: true,
        loadProfileValid: false,
        admitted: false,
    })
    assert.equal(report.playerPool.preparedIndependentStates, 4)
    assert.equal(report.steps[0].requests, 4)
    for (const entry of Object.keys(reference.entries)) {
        assert.equal(report.steps[0].entries[entry].requests, 1)
        assert.equal(report.steps[0].entries[entry].errors, 0)
    }
})

test("formal admission requires the exact mission entry load profile", () => {
    const valid = evaluateReport(structuredClone(summary), reference).gate
    assert.equal(valid.reportStructureValid, true)
    assert.equal(valid.loadProfileValid, true)
    assert.equal(valid.admitted, true)

    const cases = [
        ["prepared state count", report => {
            report.playerPool.preparedIndependentStates = 599
        }],
        ["requests-per-step declaration", report => {
            report.playerPool.requestsPerStep = 599
        }],
        ["declared concurrency step", report => {
            report.playerPool.concurrencySteps.splice(2, 1)
        }],
        ["executed concurrency step", report => {
            report.steps.splice(2, 1)
        }],
        ["duplicate concurrency step", report => {
            report.playerPool.concurrencySteps[4] = 50
            report.steps[4].concurrency = 50
        }],
        ["concurrency step order", report => {
            report.playerPool.concurrencySteps = [1, 25, 10, 50, 100]
            ;[report.steps[1], report.steps[2]] = [report.steps[2], report.steps[1]]
        }],
        ["step-to-concurrency correspondence", report => {
            report.steps[2].concurrency = 10
        }],
        ["requests in a step", report => {
            report.steps[2].requests = 599
        }],
        ["per-entry request distribution", report => {
            report.steps[2].entries["get-progress"].requests = 149
            report.steps[2].entries["single-finish"].requests = 151
        }],
    ]

    for (const [label, mutate] of cases) {
        const report = structuredClone(summary)
        mutate(report)
        const gate = evaluateReport(report, reference).gate
        assert.equal(gate.loadProfileValid, false, label)
        assert.equal(gate.admitted, false, label)
    }
})

test("formal admission rejects contradictory request and error statistics", () => {
    const cases = [
        ["structural request mismatch and hidden entry error", report => {
            report.steps[0].entries["get-progress"].structural.requests = 0
            report.steps[0].entries["get-progress"].errors = 1
        }],
        ["structural requests disagree with entry requests", report => {
            report.steps[0].entries["get-progress"].structural.requests = 0
        }],
        ["entry error is hidden by the step total", report => {
            report.steps[0].entries["get-progress"].errors = 1
        }],
        ["step error total disagrees with entries", report => {
            report.steps[0].errors = 1
        }],
    ]

    for (const [label, mutate] of cases) {
        const report = structuredClone(summary)
        mutate(report)
        const { gate } = evaluateReport(report, reference)
        assert.equal(gate.reportStructureValid, false, label)
        assert.equal(gate.zeroErrors, false, label)
        assert.equal(gate.loadProfileValid, false, label)
        assert.equal(gate.admitted, false, label)
    }
})

test("malformed reports fail closed without native errors", () => {
    const cases = [
        ["missing steps", report => {
            delete report.steps
        }],
        ["empty steps", report => {
            report.steps = []
        }],
        ["missing entry", report => {
            delete report.steps[0].entries["get-progress"]
        }],
        ["wrong step error type", report => {
            report.steps[0].errors = "0"
        }],
        ["NaN entry errors", report => {
            report.steps[0].entries["get-progress"].errors = Number.NaN
        }],
        ["NaN step requests", report => {
            report.steps[0].requests = Number.NaN
        }],
        ["wrong entry request type", report => {
            report.steps[0].entries["get-progress"].requests = "150"
        }],
        ["negative structural requests", report => {
            report.steps[0].entries["get-progress"].structural.requests = -1
        }],
        ["missing rollback result", report => {
            delete report.steps[0].rollback
        }],
        ["invalid behavior signatures", report => {
            report.steps[0].entries["get-progress"].behaviorSignatures = null
        }],
        ["NaN structural metric", report => {
            report.steps[0].entries["get-progress"].structural.sqlReadsMax = Number.NaN
        }],
    ]

    for (const [label, mutate] of cases) {
        const report = structuredClone(summary)
        mutate(report)
        let result
        assert.doesNotThrow(() => {
            result = evaluateReport(report, reference)
        }, label)
        assert.deepEqual(result.gate, {
            reportStructureValid: false,
            zeroErrors: false,
            behaviorEquivalent: false,
            rollbackVerified: false,
            sqlComputeNonIncreasing: false,
            loadProfileValid: false,
            admitted: false,
        }, label)
    }
})

test("malformed player pools fail closed", async context => {
    const cases = [
        ["playerPool string", report => {
            report.playerPool = "invalid"
        }],
        ["playerPool null", report => {
            report.playerPool = null
        }],
        ["playerPool missing", report => {
            delete report.playerPool
        }],
        ["prepared states NaN", report => {
            report.playerPool.preparedIndependentStates = Number.NaN
        }],
        ["requests per step string", report => {
            report.playerPool.requestsPerStep = "600"
        }],
        ["concurrency steps non-array", report => {
            report.playerPool.concurrencySteps = "1,10,25,50,100"
        }],
        ["concurrency steps empty", report => {
            report.playerPool.concurrencySteps = []
        }],
        ["concurrency step NaN", report => {
            report.playerPool.concurrencySteps[2] = Number.NaN
        }],
        ["concurrency step zero", report => {
            report.playerPool.concurrencySteps[0] = 0
        }],
        ["concurrency step unsafe", report => {
            report.playerPool.concurrencySteps[0] = Number.MAX_SAFE_INTEGER + 1
        }],
    ]

    for (const [label, mutate] of cases) {
        await context.test(label, () => {
            const report = structuredClone(summary)
            mutate(report)
            let result
            assert.doesNotThrow(() => {
                result = evaluateReport(report, reference)
            })
            assert.deepEqual(result.gate, {
                reportStructureValid: false,
                zeroErrors: false,
                behaviorEquivalent: false,
                rollbackVerified: false,
                sqlComputeNonIncreasing: false,
                loadProfileValid: false,
                admitted: false,
            })
        })
    }
})

test("sparse report arrays cannot gain admission", async context => {
    await context.test("sparse concurrency steps fail closed", () => {
        const report = structuredClone(summary)
        delete report.playerPool.concurrencySteps[2]
        const { gate } = evaluateReport(report, reference)
        assert.deepEqual(gate, {
            reportStructureValid: false,
            zeroErrors: false,
            behaviorEquivalent: false,
            rollbackVerified: false,
            sqlComputeNonIncreasing: false,
            loadProfileValid: false,
            admitted: false,
        })
    })

    await context.test("sparse steps fail closed", () => {
        const report = structuredClone(summary)
        delete report.steps[2]
        const { gate } = evaluateReport(report, reference)
        assert.deepEqual(gate, {
            reportStructureValid: false,
            zeroErrors: false,
            behaviorEquivalent: false,
            rollbackVerified: false,
            sqlComputeNonIncreasing: false,
            loadProfileValid: false,
            admitted: false,
        })
    })

    await context.test("sparse behavior signatures are not equivalent", () => {
        const report = structuredClone(summary)
        delete report.steps[0].entries["get-progress"].behaviorSignatures[0]
        const { gate } = evaluateReport(report, reference)
        assert.equal(gate.behaviorEquivalent, false)
        assert.equal(gate.admitted, false)
    })
})
