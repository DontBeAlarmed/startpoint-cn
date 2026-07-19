const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    executeTestGroups,
    hasExplicitSkipOutput,
    mergeChangedFiles,
    parseArguments,
} = require("./run.cjs")

test("parses group, files, and changed modes", () => {
    assert.deepEqual(parseArguments(["--group", "quick:gacha"]), {
        mode: "group",
        group: "quick:gacha",
        files: [],
        base: null,
    })
    assert.deepEqual(parseArguments(["--files", "src/lib/gacha.ts", "admin/src/App.tsx"]), {
        mode: "files",
        group: null,
        files: ["src/lib/gacha.ts", "admin/src/App.tsx"],
        base: null,
    })
    assert.deepEqual(parseArguments(["--changed", "--base", "origin/main"]), {
        mode: "changed",
        group: null,
        files: [],
        base: "origin/main",
    })
})

test("rejects conflicting selectors and base without changed", () => {
    assert.throws(
        () => parseArguments(["--group", "quick", "--changed"]),
        /exactly one/i,
    )
    assert.throws(() => parseArguments(["--base", "main"]), /requires --changed/i)
})

test("merges changed file sources with stable sorting and deduplication", () => {
    assert.deepEqual(
        mergeChangedFiles([
            ["src/z.ts", "src/a.ts"],
            ["src/a.ts", "admin/src/App.tsx"],
            ["src/new.ts"],
        ]),
        ["admin/src/App.tsx", "src/a.ts", "src/new.ts", "src/z.ts"],
    )
})

test("does not mistake a zero-valued TAP skip summary for an explicit skip", () => {
    assert.equal(hasExplicitSkipOutput("# tests 5\n# pass 5\n# skipped 0\n"), false)
    assert.equal(hasExplicitSkipOutput("fixture tests skipped: input unavailable\n"), true)
    assert.equal(hasExplicitSkipOutput("测试跳过：缺少可选输入\n"), true)
})

test("rejects unknown groups", async () => {
    await assert.rejects(
        executeTestGroups(["quick:missing"], {
            cwd: process.cwd(),
            testGroups: {},
            writeOutput() {},
        }),
        /unknown group/i,
    )
})

test("aggregates passed, failed, and explicitly skipped child processes", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

    fs.writeFileSync(
        path.join(fixtureRoot, "pass.cjs"),
        'require("node:assert/strict").equal(process.env.TS_NODE_TRANSPILE_ONLY, "1")\n',
    )
    fs.writeFileSync(path.join(fixtureRoot, "fail.cjs"), "process.exit(7)\n")
    fs.writeFileSync(
        path.join(fixtureRoot, "skip.cjs"),
        'console.log("fixture tests skipped: optional input unavailable")\n',
    )

    const report = await executeTestGroups(["quick:fixture"], {
        cwd: fixtureRoot,
        testGroups: {
            "quick:fixture": {
                execution: "parallel",
                tests: ["pass.cjs", "fail.cjs", "skip.cjs"],
            },
        },
        writeOutput() {},
    })

    assert.deepEqual(report.summary, { passed: 1, failed: 1, skipped: 1 })
    assert.equal(report.exitCode, 1)
    assert.equal(report.results.find(result => result.file === "fail.cjs").exitCode, 7)
})

test("times out and terminates a child that keeps handles open", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-timeout-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    fs.writeFileSync(path.join(fixtureRoot, "hang.cjs"), "setInterval(() => {}, 1000)\n")

    const report = await executeTestGroups(["integration:fixture"], {
        cwd: fixtureRoot,
        testGroups: {
            "integration:fixture": {
                execution: "serial",
                timeoutMs: 100,
                tests: ["hang.cjs"],
            },
        },
        writeOutput() {},
    })

    assert.equal(report.exitCode, 1)
    assert.equal(report.results[0].timedOut, true)
    assert.match(report.results[0].output, /timed out after 100ms/)
})
