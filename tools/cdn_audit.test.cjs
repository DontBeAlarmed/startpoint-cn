"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { CdnAuditError, createCdnAuditReport } = require("../src/content/cdn/audit")
const {
    AuditCliError,
    executeAuditCli,
    parseArguments,
    renderHuman,
    run,
} = require("./audit_cdn_catalog.cjs")

const PROJECT_ROOT = path.resolve(__dirname, "..")
const AUDIT_TOOL = path.join(PROJECT_ROOT, "tools/audit_cdn_catalog.cjs")

function archive(relativePath, compressedBytes, layer, order = 1) {
    return {
        relativePath,
        compressedBytes,
        sha256: "a".repeat(64),
        layer,
        order,
    }
}

function edge(fromVersion, toVersion, archives) {
    return {
        fromVersion,
        toVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        archives,
    }
}

function reportFixture() {
    const full = edge(null, "1.4.0", [
        archive("archive-common-full/full.zip", 10, "common"),
        archive("archive-medium-full/full.zip", 20, "quality"),
        archive("archive-android-full/full.zip", 30, "platform"),
    ])
    const first = edge("1.4.0", "1.4.53", [
        archive("archive-common-diff/first.zip", 1, "common"),
        archive("archive-medium-diff/first.zip", 2, "quality"),
        archive("archive-android-diff/first.zip", 3, "platform"),
    ])
    const second = edge("1.4.53", "1.4.54", [
        archive("archive-common-diff/second.zip", 4, "common"),
        archive("archive-medium-diff/second.zip", 5, "quality"),
        archive("archive-android-diff/second.zip", 6, "platform"),
    ])
    return {
        catalog: {
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 3_000,
            entityListsRelativePath: "EntityLists/test-android_medium.csv",
            edges: [full, first, second],
        },
        full,
        first,
        second,
    }
}

test("summarizes a validated catalog and an initial continuous plan", () => {
    const { catalog, full, first, second } = reportFixture()
    const report = createCdnAuditReport(catalog, {
        kind: "initial",
        full,
        diff: [first, second],
        downloadBytes: 81,
        delayedAssetsBytes: 0,
    }, {
        currentVersion: null,
        targetVersion: "1.4.54",
        platform: "android",
        requestedAssetSize: "delayed",
        effectiveAssetSize: "fulfill",
        isInitial: true,
    })

    assert.deepEqual(report, {
        schemaVersion: 1,
        auditVersion: 1,
        catalog: {
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 3_000,
            edgeCount: 3,
            diffEdgeCount: 2,
            archiveCount: 9,
            archiveCompressedBytes: 81,
            layers: {
                common: { archiveCount: 3, bytes: 15 },
                quality: { archiveCount: 3, bytes: 27 },
                platform: { archiveCount: 3, bytes: 39 },
            },
            entityListsRelativePath: "EntityLists/test-android_medium.csv",
        },
        scope: {
            platform: "android",
            assetSize: "delayed",
            effectiveAssetSize: "fulfill",
        },
        graph: {
            validationIssueCount: 0,
            forkCount: 0,
            cycleCount: 0,
            duplicateCount: 0,
            missingPathCount: 0,
            missingLayerCount: 0,
        },
        plan: {
            kind: "initial",
            currentVersion: null,
            targetVersion: "1.4.54",
            isInitial: true,
            full: { version: "1.4.0", archiveCount: 3, bytes: 60 },
            diff: [
                { fromVersion: "1.4.0", toVersion: "1.4.53", archiveCount: 3, bytes: 6 },
                { fromVersion: "1.4.53", toVersion: "1.4.54", archiveCount: 3, bytes: 15 },
            ],
            downloadBytes: 81,
            delayedAssetsBytes: 0,
        },
    })
})

function auditRequest(overrides = {}) {
    return {
        currentVersion: "1.4.54",
        targetVersion: "1.4.54",
        platform: "android",
        requestedAssetSize: "fulfill",
        effectiveAssetSize: "fulfill",
        isInitial: false,
        ...overrides,
    }
}

function upToDatePlan() {
    return {
        kind: "up-to-date",
        full: null,
        diff: null,
        downloadBytes: 0,
        delayedAssetsBytes: 0,
    }
}

test("rejects catalog byte overflow even when an up-to-date plan bypasses planner sums", () => {
    const { catalog } = reportFixture()
    const overflowingCatalog = {
        ...catalog,
        edges: [edge(null, "1.4.0", [
            archive("archive-common-full/max.zip", Number.MAX_SAFE_INTEGER, "common"),
            archive("archive-android-full/one.zip", 1, "platform", 2),
        ])],
    }

    assert.throws(
        () => createCdnAuditReport(overflowingCatalog, upToDatePlan(), auditRequest()),
        error => error?.code === "AUDIT_INTEGER_OVERFLOW",
    )
})

test("rejects layer byte overflow with a stable audit code", () => {
    const { catalog } = reportFixture()
    const overflowingCatalog = {
        ...catalog,
        edges: [edge(null, "1.4.0", [
            archive("archive-common-full/max.zip", Number.MAX_SAFE_INTEGER, "common"),
            archive("archive-common-full/one.zip", 1, "common", 2),
        ])],
    }

    assert.throws(
        () => createCdnAuditReport(overflowingCatalog, upToDatePlan(), auditRequest()),
        error => error?.code === "AUDIT_INTEGER_OVERFLOW",
    )
})

test("rejects overflow while summarizing full and diff plan edges", () => {
    const { catalog } = reportFixture()
    const overflowingArchives = [
        archive("archive-common-full/max.zip", Number.MAX_SAFE_INTEGER, "common"),
        archive("archive-quality-full/one.zip", 1, "quality", 2),
    ]
    const full = edge(null, "1.4.0", overflowingArchives)
    const diff = edge("1.4.53", "1.4.54", overflowingArchives)

    assert.throws(
        () => createCdnAuditReport(catalog, {
            kind: "initial",
            full,
            diff: null,
            downloadBytes: 0,
            delayedAssetsBytes: 0,
        }, auditRequest({ currentVersion: null, isInitial: true })),
        error => error?.code === "AUDIT_INTEGER_OVERFLOW",
    )
    assert.throws(
        () => createCdnAuditReport(catalog, {
            kind: "incremental",
            full: null,
            diff: [diff],
            downloadBytes: 0,
            delayedAssetsBytes: 0,
        }, auditRequest({ currentVersion: "1.4.53" })),
        error => error?.code === "AUDIT_INTEGER_OVERFLOW",
    )
})

test("rejects non-safe and negative audit summary inputs", () => {
    const { catalog } = reportFixture()
    assert.throws(
        () => createCdnAuditReport({ ...catalog, installedBytes: Number.NaN }, upToDatePlan(), auditRequest()),
        error => error?.code === "AUDIT_INVALID_SUMMARY_INPUT",
    )

    const invalidCatalog = {
        ...catalog,
        edges: [edge(null, "1.4.0", [archive("archive-common-full/negative.zip", -1, "common")])],
    }
    assert.throws(
        () => createCdnAuditReport(invalidCatalog, upToDatePlan(), auditRequest()),
        error => error?.code === "AUDIT_INVALID_SUMMARY_INPUT",
    )
})

function writeArchive(cdnRoot, directory, name, bytes) {
    const archiveDirectory = path.join(cdnRoot, directory)
    fs.mkdirSync(archiveDirectory, { recursive: true })
    fs.writeFileSync(path.join(archiveDirectory, name), Buffer.alloc(bytes, bytes))
}

function createFixture(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-audit-test-"))
    const cdnDir = path.join(root, "cdn-parent")
    const cdnRoot = path.join(cdnDir, "cn")
    const stateDir = path.join(root, "state")
    const storeDir = path.join(root, "store")
    const runtimeDir = path.join(root, "runtime")
    fs.mkdirSync(path.join(cdnRoot, "EntityLists"), { recursive: true })
    fs.writeFileSync(
        path.join(cdnRoot, "EntityLists/test-android_medium.csv"),
        "path,version,size,hash,layer\na,1,1000,h,common\nb,1,2000,h,platform\n",
    )

    for (const [directory, bytes] of [
        ["archive-common-full", 10],
        ["archive-medium-full", 20],
        ["archive-android-full", 30],
    ]) {
        writeArchive(cdnRoot, directory, "pinball-1.4.0-1-a.zip", bytes)
    }
    if (!options.brokenGraph) {
        for (const [directory, bytes] of [
            ["archive-common-diff", 1],
            ["archive-medium-diff", 2],
            ["archive-android-diff", 3],
        ]) {
            writeArchive(cdnRoot, directory, "pinball-1.4.0-1.4.53-1-b.zip", bytes)
        }
    }
    for (const [directory, bytes] of [
        ["archive-common-diff", 4],
        ["archive-medium-diff", 5],
        ["archive-android-diff", 6],
    ]) {
        writeArchive(cdnRoot, directory, "pinball-1.4.53-1.4.54-1-c.zip", bytes)
    }

    return { root, cdnDir, cdnRoot, stateDir, storeDir, runtimeDir }
}

function explicitPathArguments(fixture) {
    return [
        "--cdn-dir", fixture.cdnDir,
        "--content-state-dir", fixture.stateDir,
        "--content-store-dir", fixture.storeDir,
        "--content-runtime-dir", fixture.runtimeDir,
    ]
}

function runAudit(fixture, arguments_, env = {}) {
    return run([...arguments_, ...explicitPathArguments(fixture)], {
        env,
        projectRoot: PROJECT_ROOT,
    })
}

async function executeAudit(fixture, arguments_, options = {}) {
    let stdout = ""
    let stderr = ""
    let exitCode = null
    const status = await executeAuditCli(
        [...arguments_, ...explicitPathArguments(fixture)],
        {
            env: options.env ?? {},
            projectRoot: PROJECT_ROOT,
            runAudit: options.runAudit,
            stdout: { write(chunk) { stdout += String(chunk) } },
            stderr: { write(chunk) { stderr += String(chunk) } },
            setExitCode(code) { exitCode = code },
        },
    )
    assert.equal(exitCode, status)
    return { status, stdout, stderr }
}

function treeSnapshot(root) {
    const result = []
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                visit(absolutePath)
                continue
            }
            const stat = fs.statSync(absolutePath, { bigint: true })
            result.push({
                path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
                size: stat.size.toString(),
                mtimeNs: stat.mtimeNs.toString(),
                sha256: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
            })
        }
    }
    visit(root)
    return result.sort((left, right) => left.path.localeCompare(right.path))
}

test("run composes up-to-date, incremental, and initial plans without changing CDN files", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const before = treeSnapshot(fixture.cdnRoot)

    const upToDate = await runAudit(fixture, ["--json", "--current", "1.4.54"])
    assert.equal(upToDate.json, true)
    const currentReport = upToDate.report
    assert.deepEqual(currentReport.plan, {
        kind: "up-to-date",
        currentVersion: "1.4.54",
        targetVersion: "1.4.54",
        isInitial: false,
        full: null,
        diff: null,
        downloadBytes: 0,
        delayedAssetsBytes: 0,
    })
    assert.equal(currentReport.catalog.edgeCount, 3)
    assert.equal(currentReport.catalog.archiveCount, 9)
    assert.equal(currentReport.catalog.archiveCompressedBytes, 81)
    assert.equal(currentReport.graph.validationIssueCount, 0)

    const incremental = await runAudit(fixture, [
        "--json", "--current", "1.4.53", "--target", "1.4.54", "--asset-size", "shortened",
    ])
    const incrementalReport = incremental.report
    assert.deepEqual(incrementalReport.scope, {
        platform: "android",
        assetSize: "shortened",
        effectiveAssetSize: "fulfill",
    })
    assert.deepEqual(incrementalReport.plan.diff, [
        { fromVersion: "1.4.53", toVersion: "1.4.54", archiveCount: 3, bytes: 15 },
    ])
    assert.equal(incrementalReport.plan.downloadBytes, 15)

    const initial = await runAudit(fixture, [
        "--json", "--initial", "--target", "1.4.54", "--asset-size", "delayed",
    ])
    const initialReport = initial.report
    assert.equal(initialReport.plan.kind, "initial")
    assert.equal(initialReport.plan.full.version, "1.4.0")
    assert.deepEqual(initialReport.plan.diff.map(item => [item.fromVersion, item.toVersion]), [
        ["1.4.0", "1.4.53"],
        ["1.4.53", "1.4.54"],
    ])
    assert.equal(initialReport.plan.downloadBytes, 81)
    assert.equal(initialReport.plan.delayedAssetsBytes, 0)

    assert.deepEqual(treeSnapshot(fixture.cdnRoot), before)
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "cdn-digest-cache.json")), true)
    assert.equal(fs.existsSync(fixture.storeDir), false)
    assert.equal(fs.existsSync(fixture.runtimeDir), false)
})

test("human renderer is Chinese and contains no absolute paths", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await runAudit(fixture, ["--current", "1.4.54"])
    const output = renderHuman(result.report)

    assert.match(output, /CDN Catalog 只读审计/)
    assert.match(output, /已是最新版本/)
    assert.doesNotMatch(output, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.doesNotMatch(output, /\/Users\//)
})

test("argument parser rejects invalid and conflicting arguments with stable codes", () => {
    const cases = [
        [["--wat"], "AUDIT_UNKNOWN_ARGUMENT"],
        [["--wat=value"], "AUDIT_UNKNOWN_ARGUMENT"],
        [["--current", "1.4.53", "--current", "1.4.54"], "AUDIT_DUPLICATE_ARGUMENT"],
        [["--json", "--json", "--current", "1.4.54"], "AUDIT_DUPLICATE_ARGUMENT"],
        [["--initial", "--initial"], "AUDIT_DUPLICATE_ARGUMENT"],
        [["--current", ""], "AUDIT_MISSING_ARGUMENT_VALUE"],
        [["--current", "1.4.54", "--cdn-dir", "x".repeat(4097)], "AUDIT_ARGUMENT_VALUE_TOO_LONG"],
        [["--current", "01.4.54"], "AUDIT_INVALID_VERSION"],
        [["--current", "1.4.54", "--platform", "ios"], "UNSUPPORTED_PLATFORM"],
        [["--current", "1.4.54", "--asset-size", "tiny"], "UNSUPPORTED_ASSET_SIZE_KIND"],
        [["--initial", "--current", "1.4.53"], "AUDIT_INITIAL_CURRENT_CONFLICT"],
        [[], "AUDIT_CURRENT_REQUIRED"],
    ]

    for (const [arguments_, expectedCode] of cases) {
        assert.throws(
            () => parseArguments(arguments_),
            error => error instanceof AuditCliError && error.code === expectedCode,
        )
    }
})

test("execute serializes argument failures as stable JSON without a partial plan or stack", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await executeAudit(fixture, ["--json", fixture.root])

    assert.notEqual(result.status, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.error.code, "AUDIT_UNKNOWN_ARGUMENT")
    assert.equal(output.plan, undefined)
    assert.equal(result.stderr, "")
    assert.equal(result.stdout.includes(fixture.root), false)
    assert.doesNotMatch(result.stdout, /\/Users\//)
    assert.doesNotMatch(result.stdout, /at .*audit_cdn_catalog/)
})

test("execute does not echo an overlong argument value", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const secretValue = `sensitive-${"x".repeat(4097)}`
    const result = await executeAudit(fixture, ["--json", "--current", "1.4.54", "--cdn-dir", secretValue])

    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).error.code, "AUDIT_ARGUMENT_VALUE_TOO_LONG")
    assert.equal(result.stdout.includes(secretValue), false)
    assert.equal(result.stderr, "")
})

test("execute rejects a CDN_DIR ending in cn without exposing the configured path", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await executeAudit(
        { ...fixture, cdnDir: fixture.cdnRoot },
        ["--json", "--current", "1.4.54"],
    )

    assert.notEqual(result.status, 0)
    assert.equal(JSON.parse(result.stdout).error.code, "AUDIT_PATH_CONFIG_ERROR")
    assert.equal(result.stdout.includes(fixture.root), false)
})

test("execute returns a stable catalog error and no partial plan for a broken graph", async t => {
    const fixture = createFixture({ brokenGraph: true })
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await executeAudit(fixture, ["--json", "--initial", "--target", "1.4.54"])

    assert.notEqual(result.status, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.error.code, "MISSING_PATH")
    assert.equal(output.plan, undefined)
    assert.doesNotMatch(result.stdout, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("explicit path arguments override environment paths", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await runAudit(fixture, ["--current", "1.4.54"], {
        CDN_DIR: fixture.cdnRoot,
        CONTENT_STATE_DIR: fixture.cdnRoot,
        CONTENT_STORE_DIR: fixture.cdnRoot,
        CONTENT_RUNTIME_DIR: fixture.cdnRoot,
    })

    assert.equal(result.report.plan.kind, "up-to-date")
})

test("target beyond the catalog returns NO_UPDATE_PATH without a partial plan", async t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = await executeAudit(fixture, [
        "--json", "--current", "1.4.54", "--target", "1.4.55",
    ])

    assert.equal(result.status, 1)
    const output = JSON.parse(result.stdout)
    assert.equal(output.error.code, "NO_UPDATE_PATH")
    assert.equal(output.plan, undefined)
    assert.equal(result.stderr, "")
})

test("execute classifies audit integer failures without leaking a stack or partial report", async () => {
    const marker = "/private/sensitive/catalog.zip"
    const error = new CdnAuditError("AUDIT_INTEGER_OVERFLOW", marker)
    const result = await executeAudit({
        cdnDir: "unused",
        stateDir: "unused",
        storeDir: "unused",
        runtimeDir: "unused",
    }, ["--json", "--current", "1.4.54"], {
        runAudit: async () => { throw error },
    })

    assert.equal(result.status, 1)
    const output = JSON.parse(result.stdout)
    assert.equal(output.error.code, "AUDIT_INTEGER_OVERFLOW")
    assert.equal(output.plan, undefined)
    assert.equal(result.stdout.includes(marker), false)
    assert.doesNotMatch(result.stdout, /at .*cdn_audit/)
    assert.equal(result.stderr, "")
})

test("execute renders audit integer failures on the human error channel", async () => {
    const marker = "/private/sensitive/catalog.zip"
    const result = await executeAudit({
        cdnDir: "unused",
        stateDir: "unused",
        storeDir: "unused",
        runtimeDir: "unused",
    }, ["--current", "1.4.54"], {
        runAudit: async () => {
            throw new CdnAuditError("AUDIT_INVALID_SUMMARY_INPUT", marker)
        },
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /^错误 \[AUDIT_INVALID_SUMMARY_INPUT\]：审计汇总失败：AUDIT_INVALID_SUMMARY_INPUT\n$/)
    assert.equal(result.stderr.includes(marker), false)
    assert.doesNotMatch(result.stderr, /at .*cdn_audit/)
})

test("script runs from a fixture cwd and emits JSON with a zero exit code", t => {
    const fixture = createFixture()
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
    const result = spawnSync(process.execPath, [
        AUDIT_TOOL,
        "--json",
        "--current", "1.4.54",
        ...explicitPathArguments(fixture),
    ], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {},
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).plan.kind, "up-to-date")
    assert.equal(result.stderr, "")
})
