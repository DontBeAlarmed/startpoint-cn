"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { summarizeHttpSamples } = require("./http_metrics.cjs")

test("summarizes latency quantiles and response outcomes", () => {
    const result = summarizeHttpSamples([
        { durationMs: 10, status: 200 },
        { durationMs: 20, status: 200 },
        { durationMs: 30, status: 503 },
        { durationMs: 40, error: "timeout" },
    ])

    assert.deepEqual(result, {
        count: 4,
        completed: 3,
        errors: 1,
        httpErrors: 1,
        p50Ms: 20,
        p95Ms: 40,
        p99Ms: 40,
        statusCounts: { "200": 2, "503": 1 },
    })
})

test("rejects an empty sample set", () => {
    assert.throws(() => summarizeHttpSamples([]), /at least one sample/)
})
