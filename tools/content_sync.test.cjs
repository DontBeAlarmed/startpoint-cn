"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { buildCdnCatalog } = require("../src/content/cdn/catalog-builder")
const { ContentObjectStore } = require("../src/content/sync/object-store")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
const {
    ContentSyncLockCleanupError,
    ContentSyncLockError,
    acquireContentSyncLock,
} = require("../src/content/sync/lock")
const {
    ContentSyncCleanupError,
    runContentSync,
} = require("../src/content/sync/engine")
const {
    parseContentSyncArguments,
    runContentSyncCli,
} = require("../src/content/sync/cli")

const projectRoot = path.resolve(__dirname, "..")
const confirmedSeedsPath = path.join(projectRoot, "assets", "confirmed_seeds.json")
const confirmedSeedsDigest = crypto.createHash("sha256")
    .update(fs.readFileSync(confirmedSeedsPath))
    .digest("hex")
const TEST_TABLE_SOURCES = TABLE_SOURCES.slice(0, 2)

function createSandbox(t, prefix = "content-sync-") {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const paths = {
        cdnDir: path.join(sandbox, ".cdn"),
        cdnRoot: path.join(sandbox, ".cdn", "cn"),
        contentRootDir: path.join(sandbox, ".content"),
        contentStoreDir: path.join(sandbox, ".content-store"),
        contentStateDir: path.join(sandbox, ".content-state"),
        contentRuntimeDir: path.join(sandbox, ".content-runtime"),
    }
    fs.mkdirSync(paths.cdnRoot, { recursive: true })
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return { paths, sandbox }
}

function fakeScan(paths, targetVersion = "1.4.54") {
    return {
        cdnRoot: paths.cdnRoot,
        targetVersion,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
        entityListsFingerprint: {
            physicalPath: path.join(paths.cdnRoot, "EntityLists", `${targetVersion}.csv`),
            compressedBytes: 1,
            mtimeMs: "1",
            ctimeMs: "1",
            dev: "1",
            ino: "1",
        },
        archives: [],
        ignoredPaths: ["ignored.txt"],
    }
}

function fakeCatalog(targetVersion) {
    return {
        targetVersion,
        versions: [targetVersion],
        edges: [],
        installedBytes: 1,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
    }
}

function tableValues(marker = "stable", definitions = TEST_TABLE_SOURCES) {
    return new Map(definitions.map(definition => [
        definition.tableName,
        { marker, tableName: definition.tableName },
    ]))
}

function engineFixture(t, options = {}) {
    const { paths, sandbox } = createSandbox(t)
    const store = new ContentObjectStore(paths)
    const calls = {
        scan: 0,
        materialize: 0,
        catalog: 0,
        index: 0,
        builder: 0,
    }
    let targetVersion = options.targetVersion ?? "1.4.54"
    const tableSources = options.tableSources ?? TEST_TABLE_SOURCES
    let builderValues = options.builderValues ?? tableValues("stable", tableSources)
    const dependencies = {
        resolvePaths: () => paths,
        createStore: () => store,
        scanTarget: async () => {
            calls.scan++
            return fakeScan(paths, targetVersion)
        },
        materializeCatalog: async scan => {
            calls.materialize++
            return { targetVersion: scan.targetVersion }
        },
        buildCatalog: input => {
            calls.catalog++
            return fakeCatalog(input.targetVersion)
        },
        buildArchiveIndex: async () => {
            calls.index++
            return { marker: "index" }
        },
        tableBuilder: {
            build: async () => {
                calls.builder++
                return builderValues
            },
        },
        tableSources,
        ...options.dependencies,
    }
    return {
        calls,
        dependencies,
        paths,
        sandbox,
        store,
        setBuilderValues(value) { builderValues = value },
        setTargetVersion(value) { targetVersion = value },
    }
}

async function sync(fixture, options = {}) {
    return runContentSync({
        projectRoot,
        mode: "normal",
        generatorVersion: 1,
        ...options,
    }, fixture.dependencies)
}

async function readCurrentRelease(store) {
    const current = await store.readCurrent()
    return current === null ? null : store.readRelease(current)
}

test("check scans current metadata without locking, materializing, indexing, or writing", async t => {
    const fixture = engineFixture(t, {
        dependencies: {
            acquireLock: async () => { throw new Error("check acquired a lock") },
        },
    })
    const result = await sync(fixture, { mode: "check" })

    assert.deepEqual(result, {
        status: "check",
        action: "synchronize",
        targetVersion: "1.4.54",
        currentVersion: null,
        reason: "missing",
    })
    assert.equal(fixture.calls.scan, 1)
    assert.equal(fixture.calls.materialize, 0)
    assert.equal(fixture.calls.catalog, 0)
    assert.equal(fixture.calls.index, 0)
    assert.equal(fixture.calls.builder, 0)
    assert.equal(fs.existsSync(fixture.paths.contentRootDir), false)
})

test("check consumes the store current release snapshot without rereading it", async t => {
    const { paths } = createSandbox(t)
    let snapshotReads = 0
    const current = {
        schemaVersion: 1,
        assetVersion: "1.4.54",
        release: `releases/1.4.54-${"a".repeat(64)}/manifest.json`,
    }
    const manifest = { assetVersion: "1.4.54", generatorVersion: 1 }
    const result = await runContentSync({
        projectRoot,
        mode: "check",
        generatorVersion: 1,
    }, {
        resolvePaths: () => paths,
        scanTarget: async () => fakeScan(paths),
        createStore: () => ({
            readCurrentRelease: async () => {
                snapshotReads++
                return { current, manifest }
            },
            readCurrent: async () => { throw new Error("current pointer was reread") },
            readRelease: async () => { throw new Error("release manifest was reread") },
        }),
    })

    assert.equal(result.reason, "up-to-date")
    assert.equal(snapshotReads, 1)
})

test("normal sync creates a missing release and skips the same asset/generator", async t => {
    const fixture = engineFixture(t)
    const first = await sync(fixture)
    const second = await sync(fixture)

    assert.equal(first.status, "synchronized")
    assert.equal(first.reason, "missing")
    assert.match(first.releaseDigest, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(second, {
        status: "skipped",
        action: "skip",
        targetVersion: "1.4.54",
        currentVersion: "1.4.54",
        reason: "up-to-date",
    })
    assert.equal(fixture.calls.builder, 1)
})

test("generator changes, upgrades, explicit rollbacks, and force trigger rebuilds", async t => {
    const fixture = engineFixture(t)
    const initial = await sync(fixture)
    const generator = await sync(fixture, { generatorVersion: 2 })
    fixture.setTargetVersion("1.5.0")
    const upgrade = await sync(fixture, { generatorVersion: 2 })
    fixture.setTargetVersion("1.4.54")
    const rollback = await sync(fixture, { generatorVersion: 2 })
    const forced = await sync(fixture, { generatorVersion: 2, mode: "force" })

    assert.equal(generator.reason, "generator-version")
    assert.equal(upgrade.reason, "asset-version")
    assert.equal(rollback.reason, "asset-version")
    assert.equal(forced.reason, "forced")
    assert.equal(forced.releaseDigest, rollback.releaseDigest)
    assert.notEqual(generator.releaseDigest, initial.releaseDigest)
    assert.equal(fixture.calls.builder, 5)
})

test("catalog, tables, and summary are stored without physical or absolute paths", async t => {
    const fixture = engineFixture(t, {
        tableSources: TABLE_SOURCES,
        builderValues: tableValues("stable", TABLE_SOURCES),
    })
    const result = await sync(fixture)
    const manifest = await readCurrentRelease(fixture.store)
    assert.ok(manifest)
    assert.equal(manifest.releaseDigest, result.releaseDigest)
    assert.deepEqual(Object.keys(manifest.tables), TABLE_SOURCES.map(item => item.tableName))

    const catalog = await fixture.store.readObject(manifest.catalog.object)
    const summary = await fixture.store.readObject(manifest.summary.object)
    assert.deepEqual(catalog, fakeCatalog("1.4.54"))
    assert.equal(JSON.stringify(summary).includes(fixture.sandbox), false)
    assert.equal(JSON.stringify(summary).includes("physicalPath"), false)
    assert.equal(JSON.stringify(summary).includes("cdnRoot"), false)
    assert.equal(path.isAbsolute(summary.entityListsRelativePath), false)
})

test("missing or extra builder tables fail before activation", async t => {
    for (const kind of ["missing", "extra"]) {
        await t.test(kind, async t => {
            const fixture = engineFixture(t)
            const values = tableValues()
            if (kind === "missing") values.delete(TEST_TABLE_SOURCES[0].tableName)
            else values.set("extra.json", {})
            fixture.setBuilderValues(values)
            await assert.rejects(sync(fixture), /table.*(?:missing|extra)|(?:missing|extra).*table/i)
            assert.equal(await fixture.store.readCurrent(), null)
        })
    }
})

test("materialize, catalog build, archive index, table build, manifest, and activation failures preserve current", async t => {
    const stages = ["materialize", "catalog", "index", "builder", "manifest", "activate"]
    for (const stage of stages) {
        await t.test(stage, async t => {
            const fixture = engineFixture(t)
            await sync(fixture)
            const before = fs.readFileSync(path.join(fixture.paths.contentRootDir, "current.json"))
            fixture.setTargetVersion("1.5.0")

            if (stage === "materialize") fixture.dependencies.materializeCatalog = async () => { throw new Error(stage) }
            if (stage === "catalog") fixture.dependencies.buildCatalog = () => { throw new Error(stage) }
            if (stage === "index") fixture.dependencies.buildArchiveIndex = async () => { throw new Error(stage) }
            if (stage === "builder") fixture.dependencies.tableBuilder = { build: async () => { throw new Error(stage) } }
            if (stage === "manifest" || stage === "activate") {
                fixture.dependencies.createStore = () => new Proxy(fixture.store, {
                    get(target, property) {
                        if (property === (stage === "manifest" ? "writeRelease" : "activate")) {
                            return async () => { throw new Error(stage) }
                        }
                        const value = Reflect.get(target, property, target)
                        return typeof value === "function" ? value.bind(target) : value
                    },
                })
            }

            await assert.rejects(sync(fixture), new RegExp(stage))
            assert.deepEqual(
                fs.readFileSync(path.join(fixture.paths.contentRootDir, "current.json")),
                before,
            )
        })
    }
})

test("sync and lock release failures preserve both diagnostics", async t => {
    const fixture = engineFixture(t, {
        dependencies: {
            acquireLock: async () => ({
                lockPath: path.join(fixture.paths.contentRootDir, "sync.lock"),
                release: async () => { throw new Error("release failed") },
            }),
            tableBuilder: {
                build: async () => { throw new Error("builder failed") },
            },
        },
    })

    await assert.rejects(
        sync(fixture),
        error => error instanceof ContentSyncCleanupError
            && /builder failed/.test(error.synchronizationError.message)
            && /release failed/.test(error.releaseError.message),
    )
})

test("two concurrent normal syncs build once and the waiter rechecks after locking", async t => {
    let releaseBuilder
    const gate = new Promise(resolve => { releaseBuilder = resolve })
    let enteredBuilder
    const entered = new Promise(resolve => { enteredBuilder = resolve })
    const fixture = engineFixture(t, {
        dependencies: {
            tableBuilder: {
                build: async () => {
                    fixture.calls.builder++
                    enteredBuilder()
                    await gate
                    return tableValues()
                },
            },
        },
    })

    const first = sync(fixture)
    await entered
    const second = sync(fixture)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(fixture.calls.builder, 1)
    releaseBuilder()

    assert.equal((await first).status, "synchronized")
    assert.equal((await second).status, "skipped")
    assert.equal(fixture.calls.builder, 1)
})

test("lock waits, times out clearly, releases by token and identity, and leaves no failed-create file", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-")
    const first = await acquireContentSyncLock(paths.contentRootDir, {
        timeoutMs: 100,
        pollIntervalMs: 5,
    })
    await assert.rejects(
        acquireContentSyncLock(paths.contentRootDir, { timeoutMs: 20, pollIntervalMs: 5 }),
        error => error instanceof ContentSyncLockError
            && error.code === "CONTENT_SYNC_LOCK_TIMEOUT"
            && /remove.*manually|人工删除/i.test(error.message),
    )
    await first.release()
    assert.equal(fs.existsSync(path.join(paths.contentRootDir, "sync.lock")), false)

    await assert.rejects(
        acquireContentSyncLock(paths.contentRootDir, {
            timeoutMs: 20,
            writeLock: async () => { throw new Error("write failed") },
        }),
        /write failed/,
    )
    assert.equal(fs.existsSync(path.join(paths.contentRootDir, "sync.lock")), false)

    const lock = await acquireContentSyncLock(paths.contentRootDir)
    const lockPath = path.join(paths.contentRootDir, "sync.lock")
    fs.unlinkSync(lockPath)
    fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, token: "other", pid: 1 }))
    await assert.rejects(lock.release(), /identity|token|replaced/i)
    assert.equal(fs.existsSync(lockPath), true)
})

test("lock rejects a symlink and reports an existing legacy lock", async t => {
    const { paths, sandbox } = createSandbox(t, "content-sync-lock-link-")
    fs.mkdirSync(paths.contentRootDir)
    const outside = path.join(sandbox, "outside.lock")
    fs.writeFileSync(outside, "outside")
    fs.symlinkSync(outside, path.join(paths.contentRootDir, "sync.lock"))
    await assert.rejects(
        acquireContentSyncLock(paths.contentRootDir, { timeoutMs: 10, pollIntervalMs: 2 }),
        /symlink|symbolic/i,
    )
    assert.equal(fs.readFileSync(outside, "utf8"), "outside")
})

test("lock creation preserves the operation error when handle cleanup also fails", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-cleanup-")
    await assert.rejects(
        acquireContentSyncLock(paths.contentRootDir, {
            writeLock: async handle => {
                const close = handle.close.bind(handle)
                handle.close = async () => {
                    await close()
                    throw new Error("close failed")
                }
                throw new Error("write failed")
            },
        }),
        error => error instanceof ContentSyncLockCleanupError
            && /write failed/.test(error.operationError.message)
            && error.cleanupErrors.some(item => /close failed/.test(item.message)),
    )
    assert.equal(fs.existsSync(path.join(paths.contentRootDir, "sync.lock")), false)
})

test("lock waits through the owner's create/write window and diagnoses legacy files", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-race-")
    let finishWrite
    const writeGate = new Promise(resolve => { finishWrite = resolve })
    let writeStarted
    const started = new Promise(resolve => { writeStarted = resolve })
    const firstPromise = acquireContentSyncLock(paths.contentRootDir, {
        timeoutMs: 500,
        pollIntervalMs: 5,
        writeLock: async (handle, bytes) => {
            writeStarted()
            await writeGate
            await handle.writeFile(bytes)
        },
    })
    await started
    const secondPromise = acquireContentSyncLock(paths.contentRootDir, {
        timeoutMs: 500,
        pollIntervalMs: 5,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    finishWrite()
    const first = await firstPromise
    await first.release()
    const second = await secondPromise
    await second.release()

    fs.writeFileSync(path.join(paths.contentRootDir, "sync.lock"), "old lock")
    await assert.rejects(
        acquireContentSyncLock(paths.contentRootDir, { timeoutMs: 10, pollIntervalMs: 2 }),
        error => error instanceof ContentSyncLockError
            && error.code === "CONTENT_SYNC_LOCK_LEGACY"
            && /remove|人工删除/i.test(error.message),
    )
})

test("CLI parses mutually exclusive modes, returns exit codes, and never prints absolute paths", async () => {
    assert.deepEqual(parseContentSyncArguments([]), { mode: "normal" })
    assert.deepEqual(parseContentSyncArguments(["--check"]), { mode: "check" })
    assert.deepEqual(parseContentSyncArguments(["--force"]), { mode: "force" })
    assert.throws(() => parseContentSyncArguments(["--check", "--force"]), /mutually|互斥/i)
    assert.throws(() => parseContentSyncArguments(["--unknown"]), /unknown|未知/i)

    let stdout = ""
    let stderr = ""
    let exitCode = null
    const success = await runContentSyncCli(["--check"], {
        projectRoot,
        runSync: async options => ({
            status: "check",
            action: "skip",
            targetVersion: "1.4.54",
            currentVersion: "1.4.54",
            reason: "up-to-date",
            mode: options.mode,
        }),
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })
    assert.equal(success, 0)
    assert.equal(exitCode, 0)
    assert.equal(stderr, "")
    assert.deepEqual(JSON.parse(stdout), {
        status: "check",
        action: "skip",
        targetVersion: "1.4.54",
        currentVersion: "1.4.54",
        reason: "up-to-date",
    })

    stdout = ""
    stderr = ""
    const failure = await runContentSyncCli([], {
        projectRoot,
        runSync: async () => {
            throw new Error(
                `/private/secret failed in ${projectRoot}; `
                + `'C:\\Users\\Alice\\Secret Folder\\config.json'; `
                + `'\\\\server\\share\\Private Folder\\catalog.json'`,
            )
        },
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })
    assert.equal(failure, 1)
    assert.equal(exitCode, 1)
    assert.equal(stdout, "")
    assert.equal(stderr.includes(projectRoot), false)
    assert.equal(stderr.includes("/private/secret"), false)
    assert.equal(stderr.includes("Alice"), false)
    assert.equal(stderr.includes("Secret Folder"), false)
    assert.equal(stderr.includes("server\\share"), false)
    assert.equal(stderr.includes("Private Folder"), false)
})

test("package and quick workflow expose content sync", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.equal(
        packageJson.scripts["content:sync"],
        "node tools/content_sync.cjs",
    )
    assert.ok(TEST_GROUPS["quick:content"].tests.includes("tools/content_sync.test.cjs"))
    assert.ok(fs.existsSync(path.join(projectRoot, "tools", "content_sync.cjs")))
})

test("content sync loads an optional project env file without requiring one", () => {
    const { loadOptionalProjectEnv } = require("./content_sync.cjs")
    const loaded = []

    assert.equal(loadOptionalProjectEnv(projectRoot, {
        existsSync: () => false,
        loadEnvFile: filePath => { loaded.push(filePath) },
    }), false)
    assert.deepEqual(loaded, [])

    assert.equal(loadOptionalProjectEnv(projectRoot, {
        existsSync: () => true,
        loadEnvFile: filePath => { loaded.push(filePath) },
    }), true)
    assert.deepEqual(loaded, [path.join(projectRoot, ".env")])
})

test("content sync bootstrap hides initialization paths", async () => {
    const { runContentSyncBootstrap } = require("./content_sync.cjs")
    let stderr = ""
    let exitCode = null
    const result = await runContentSyncBootstrap({
        projectRoot,
        loadEnv: () => { throw new Error(`/private/secret-config failed in ${projectRoot}`) },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })

    assert.equal(result, 1)
    assert.equal(exitCode, 1)
    assert.match(stderr, /CONTENT_SYNC_BOOTSTRAP_FAILED/)
    assert.equal(stderr.includes(projectRoot), false)
    assert.equal(stderr.includes("/private/secret-config"), false)
})

test("content sync never modifies confirmed seeds", () => {
    const currentDigest = crypto.createHash("sha256")
        .update(fs.readFileSync(confirmedSeedsPath))
        .digest("hex")
    assert.equal(currentDigest, confirmedSeedsDigest)
})
