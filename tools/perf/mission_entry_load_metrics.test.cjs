"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createAdmissionGate,
    parseArgs,
    runBounded,
    summarizeLatencies,
} = require("./mission_entry_load_metrics.cjs")

test("layered load defaults model 600 states separately from concurrency steps", () => {
    assert.deepEqual(parseArgs([]), {
        players: 600,
        concurrencies: [1, 10, 25, 50, 100],
        output: null,
    })
    assert.deepEqual(parseArgs([
        "--players", "12",
        "--concurrency", "1,3,6",
        "--output", "report.json",
    ]), {
        players: 12,
        concurrencies: [1, 3, 6],
        output: "report.json",
    })
    assert.throws(() => parseArgs(["--concurrency", "0,2"]), /positive integers/)
    assert.throws(
        () => parseArgs(["--reference-output", "spoofed-reference.json"]),
        /unknown argument/,
    )
})

test("bounded runner never exceeds the requested in-flight work", async () => {
    let active = 0
    let maximum = 0
    const tasks = Array.from({ length: 19 }, (_, index) => async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setImmediate(resolve))
        active--
        return index
    })
    const results = await runBounded(tasks, 4)
    assert.deepEqual(results, Array.from({ length: 19 }, (_, index) => index))
    assert.equal(maximum, 4)
})

test("latency summary and admission gate use structural hard checks only", () => {
    assert.deepEqual(summarizeLatencies([9, 1, 5, 3, 7]), { p50: 5, p95: 9 })
    assert.deepEqual(createAdmissionGate({
        errors: 0,
        behaviorEquivalent: true,
        rollbackVerified: true,
        structuralComparisons: [
            { entry: "get-progress", sqlNonIncreasing: true, computeNonIncreasing: true },
            { entry: "single-finish", sqlNonIncreasing: true, computeNonIncreasing: true },
        ],
    }), {
        zeroErrors: true,
        behaviorEquivalent: true,
        rollbackVerified: true,
        sqlComputeNonIncreasing: true,
        admitted: true,
    })
    assert.equal(createAdmissionGate({
        errors: 1,
        behaviorEquivalent: true,
        rollbackVerified: true,
        structuralComparisons: [],
    }).admitted, false)
})
