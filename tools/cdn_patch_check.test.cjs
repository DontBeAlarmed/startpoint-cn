"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    runPatchCheck,
    runPatchCheckCli,
    summarizePatchCheck,
} = require("../src/content/cdn/patch-check")

function catalog() {
    return {
        schemaVersion: 1,
        fullBaseVersion: "1.4.0",
        targetVersion: "1.4.56",
        installedBytes: 100,
        entityListsRelativePath: "EntityLists/cn.csv",
        edges: [],
    }
}

function scan() {
    return {
        cdnRoot: "/cdn/cn",
        patchesRoot: "/cdn/patches",
        targetVersion: "1.4.56",
        entityListsRelativePath: "EntityLists/cn.csv",
        entityListsFingerprint: {},
        patchManifests: [
            { targetVersion: "1.4.55" },
            { targetVersion: "1.4.56" },
        ],
        archives: [
            {
                source: { kind: "baseline" },
                compressedBytes: 900,
            },
            {
                source: { kind: "patch", targetVersion: "1.4.55" },
                compressedBytes: 11,
            },
            {
                source: { kind: "patch", targetVersion: "1.4.55" },
                compressedBytes: 12,
            },
            {
                source: { kind: "patch", targetVersion: "1.4.56" },
                compressedBytes: 13,
            },
        ],
        ignoredPaths: [],
    }
}

test("summarizes validated overlay packages without exposing physical paths", () => {
    assert.deepEqual(summarizePatchCheck(scan(), catalog()), {
        schemaVersion: 1,
        status: "valid",
        baselineVersion: "1.4.54",
        targetVersion: "1.4.56",
        patchCount: 2,
        patchArchiveCount: 3,
        patchBytes: 36,
        patches: [
            { targetVersion: "1.4.55", archiveCount: 2, bytes: 23 },
            { targetVersion: "1.4.56", archiveCount: 1, bytes: 13 },
        ],
    })
})

test("patch check performs target scan and full catalog materialization without syncing", async () => {
    const calls = []
    const fakeScan = scan()
    const fakeCatalog = catalog()
    const result = await runPatchCheck({
        projectRoot: "/project",
        env: { CDN_DIR: "/cdn" },
    }, {
        resolvePaths: options => {
            calls.push(["paths", options])
            return { cdnRoot: "/cdn/cn", patchesRoot: "/cdn/patches" }
        },
        scanTarget: async paths => {
            calls.push(["scan", paths])
            return fakeScan
        },
        materializeCatalog: async received => {
            calls.push(["materialize", received])
            return { archives: [], installedBytes: 0, entityListsRelativePath: "EntityLists/cn.csv" }
        },
        buildCatalog: input => {
            calls.push(["catalog", input])
            return fakeCatalog
        },
    })

    assert.equal(result.status, "valid")
    assert.deepEqual(calls.map(([name]) => name), ["paths", "scan", "materialize", "catalog"])
})

test("patch check CLI emits one JSON result and sanitizes failures", async () => {
    let stdout = ""
    let stderr = ""
    const exitCodes = []
    const success = await runPatchCheckCli([], {
        projectRoot: "/project",
        runCheck: async () => summarizePatchCheck(scan(), catalog()),
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: code => { exitCodes.push(code) },
    })

    assert.equal(success, 0)
    assert.equal(JSON.parse(stdout).status, "valid")
    assert.equal(stderr, "")
    assert.deepEqual(exitCodes, [0])

    stdout = ""
    stderr = ""
    exitCodes.length = 0
    const failed = await runPatchCheckCli([], {
        projectRoot: "/project",
        runCheck: async () => { throw new Error(`invalid /project/private/archive.zip`) },
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: code => { exitCodes.push(code) },
    })

    assert.equal(failed, 1)
    assert.equal(stdout, "")
    assert.equal(stderr, "错误 [CDN_PATCH_CHECK_FAILED]：invalid <PROJECT_ROOT>/<PATH>\n")
    assert.deepEqual(exitCodes, [1])
})

test("patch check CLI rejects arguments without starting validation", async () => {
    let called = false
    let stderr = ""
    const result = await runPatchCheckCli(["--force"], {
        projectRoot: path.resolve("/project"),
        runCheck: async () => {
            called = true
            return summarizePatchCheck(scan(), catalog())
        },
        stdout: { write() {} },
        stderr: { write: value => { stderr += value } },
        setExitCode() {},
    })

    assert.equal(result, 1)
    assert.equal(called, false)
    assert.match(stderr, /CDN_PATCH_CHECK_UNKNOWN_ARGUMENT/)
})
