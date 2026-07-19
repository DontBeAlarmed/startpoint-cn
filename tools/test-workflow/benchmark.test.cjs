const assert = require("node:assert/strict")
const test = require("node:test")

const {
    DEFAULT_COMMANDS,
    evaluateThreshold,
    median,
    parseRunnerSummary,
} = require("./benchmark.cjs")

test("runs the changed benchmark directly with an explicit source file", () => {
    const command = DEFAULT_COMMANDS.find(candidate => candidate.name === "test:changed")

    assert.equal(command.executable, process.execPath)
    assert.deepEqual(command.args, [
        "tools/test-workflow/run.cjs",
        "--files",
        "src/lib/gacha.ts",
    ])
    assert.equal(
        command.command,
        "node tools/test-workflow/run.cjs --files src/lib/gacha.ts",
    )
})

test("calculates odd and even medians without changing the samples", () => {
    const oddSamples = [9, 1, 5]
    const evenSamples = [9, 1, 5, 3]

    assert.equal(median(oddSamples), 5)
    assert.equal(median(evenSamples), 4)
    assert.deepEqual(oddSamples, [9, 1, 5])
    assert.deepEqual(evenSamples, [9, 1, 5, 3])
})

test("fails threshold evaluation when the median exceeds the limit", () => {
    assert.deepEqual(evaluateThreshold({
        commandExitCodes: [0, 0, 0],
        medianMs: 5001,
        reportOnly: false,
        thresholdMs: 5000,
    }), {
        commandSucceeded: true,
        exitCode: 1,
        withinThreshold: false,
    })
})

test("keeps command failures non-zero even in report-only mode", () => {
    assert.deepEqual(evaluateThreshold({
        commandExitCodes: [0, 7, 0],
        medianMs: 100,
        reportOnly: true,
        thresholdMs: 5000,
    }), {
        commandSucceeded: false,
        exitCode: 1,
        withinThreshold: true,
    })
})

test("allows an exceeded threshold in report-only mode", () => {
    assert.equal(evaluateThreshold({
        commandExitCodes: [0, 0, 0],
        medianMs: 5001,
        reportOnly: true,
        thresholdMs: 5000,
    }).exitCode, 0)
})

test("parses passed, failed, and skipped counts from the last runner summary", () => {
    const output = [
        "Summary: passed=1 failed=2 skipped=3 total=40ms",
        "npm notice unrelated output",
        "Summary: passed=14 failed=0 skipped=1 total=1.24s",
    ].join("\n")

    assert.deepEqual(parseRunnerSummary(output), {
        failed: 0,
        passed: 14,
        skipped: 1,
    })
    assert.equal(parseRunnerSummary("TypeScript completed without output"), null)
})
