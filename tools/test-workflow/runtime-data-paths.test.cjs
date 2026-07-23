const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "../..")
const {
    prepareDataVolume,
    resolveRuntimeDataPaths,
} = require("../../src/runtime/data-paths")

const STATE_CASES = [
    { fileName: "active_account.json", targetKey: "activeAccountFile" },
    { fileName: "default_save.json", targetKey: "defaultSaveFile" },
]

function createTemporaryDirectory(prefix = "wdfp-data-volume-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeTemporaryDirectory(directory) {
    fs.rmSync(directory, { force: true, recursive: true })
}

function fixedTemporaryFile(paths, fileName) {
    return path.join(paths.stateDir, `.${fileName}.migrate.tmp`)
}

function createHostSymlink(t, target, linkPath, type = "file") {
    const hostType = process.platform === "win32" && type === "dir" ? "junction" : type
    try {
        fs.symlinkSync(target, linkPath, hostType)
        return true
    } catch (error) {
        if (
            process.platform === "win32"
            && ["EACCES", "EPERM", "ENOTSUP", "ENOSYS"].includes(error.code)
        ) {
            t.skip(`symbolic link creation is unavailable on this Windows host: ${error.code}`)
            return false
        }
        throw error
    }
}

test("DATA_DIR takes precedence over WDFP_DATABASE_DIR and resolves absolutely", () => {
    const paths = resolveRuntimeDataPaths({
        DATA_DIR: "relative-data",
        WDFP_DATABASE_DIR: "legacy-data",
    })

    assert.equal(paths.dataDir, path.resolve("relative-data"))
    assert.equal(paths.databaseFile, path.join(paths.dataDir, "wdfp_data.db"))
    assert.equal(paths.databaseVersionFile, path.join(paths.dataDir, "wdfp_data.db.version"))
    assert.equal(paths.stateDir, path.join(paths.dataDir, "state"))
    assert.equal(paths.seedStateDir, path.join(paths.stateDir, "seeds"))
    assert.equal(paths.seedStateFile, path.join(paths.seedStateDir, "seed-state.json"))
    assert.equal(
        paths.seedStateTemporaryFilePrefix,
        path.join(paths.seedStateDir, ".seed-state.json."),
    )
    assert.equal(Object.hasOwn(paths, "seedStateTemporaryFile"), false)
    assert.equal(paths.activeAccountFile, path.join(paths.stateDir, "active_account.json"))
    assert.equal(paths.defaultSaveFile, path.join(paths.stateDir, "default_save.json"))
})

test("falls back to WDFP_DATABASE_DIR when DATA_DIR is unset", () => {
    const paths = resolveRuntimeDataPaths({ WDFP_DATABASE_DIR: "legacy-data" })
    assert.equal(paths.dataDir, path.resolve("legacy-data"))
})

test("defaults to the project .database directory", () => {
    const paths = resolveRuntimeDataPaths({})
    assert.equal(paths.dataDir, path.join(projectRoot, ".database"))
})

test("prepares the data root and state directory repeatedly", t => {
    const parent = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(parent))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "volume") })

    assert.deepEqual(prepareDataVolume(paths), paths)
    assert.deepEqual(prepareDataVolume(paths), paths)
    assert.equal(fs.statSync(paths.dataDir).isDirectory(), true)
    assert.equal(fs.statSync(paths.stateDir).isDirectory(), true)
})

for (const { fileName, targetKey } of STATE_CASES) {
    test(`migrates ${fileName} through its fixed temporary file and rename`, t => {
        const dataDir = createTemporaryDirectory()
        t.after(() => removeTemporaryDirectory(dataDir))
        const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
        const source = path.join(dataDir, fileName)
        const target = paths[targetKey]
        const temporary = fixedTemporaryFile(paths, fileName)
        const renames = []
        fs.writeFileSync(source, `legacy-${fileName}`)
        const tracingFileSystem = {
            ...fs,
            renameSync(from, to) {
                renames.push([from, to])
                fs.renameSync(from, to)
            },
        }

        prepareDataVolume(paths, tracingFileSystem)

        assert.deepEqual(renames, [[temporary, target]])
        assert.equal(fs.readFileSync(target, "utf8"), `legacy-${fileName}`)
        assert.equal(fs.existsSync(source), false)
        assert.equal(fs.existsSync(temporary), false)
    })

    test(`keeps canonical ${fileName} and removes a stale legacy source`, t => {
        const dataDir = createTemporaryDirectory()
        t.after(() => removeTemporaryDirectory(dataDir))
        const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
        const source = path.join(dataDir, fileName)
        const target = paths[targetKey]
        fs.mkdirSync(paths.stateDir)
        fs.writeFileSync(source, "stale-legacy")
        fs.writeFileSync(target, "canonical-state")

        prepareDataVolume(paths)

        assert.equal(fs.readFileSync(target, "utf8"), "canonical-state")
        assert.equal(fs.existsSync(source), false)
    })

    test(`retries ${fileName} after an interrupted temporary copy`, t => {
        const dataDir = createTemporaryDirectory()
        t.after(() => removeTemporaryDirectory(dataDir))
        const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
        const source = path.join(dataDir, fileName)
        const temporary = fixedTemporaryFile(paths, fileName)
        fs.mkdirSync(paths.stateDir)
        fs.writeFileSync(source, "complete-legacy-state")
        fs.writeFileSync(temporary, "partial")

        prepareDataVolume(paths)

        assert.equal(fs.readFileSync(paths[targetKey], "utf8"), "complete-legacy-state")
        assert.equal(fs.existsSync(source), false)
        assert.equal(fs.existsSync(temporary), false)
    })
}

test("retries legacy cleanup after canonical publication when deletion fails", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(source, "legacy-state")
    fs.writeFileSync(paths.activeAccountFile, "canonical-state")
    let rejectDeletion = true
    const failingFileSystem = {
        ...fs,
        unlinkSync(target) {
            if (target === source && rejectDeletion) {
                rejectDeletion = false
                const error = new Error("simulated legacy cleanup failure")
                error.code = "EACCES"
                throw error
            }
            fs.unlinkSync(target)
        },
    }

    assert.throws(
        () => prepareDataVolume(paths, failingFileSystem),
        /failed to remove legacy state file.*simulated legacy cleanup failure/i,
    )
    assert.equal(fs.readFileSync(paths.activeAccountFile, "utf8"), "canonical-state")
    assert.equal(fs.existsSync(source), true)

    prepareDataVolume(paths)
    assert.equal(fs.existsSync(source), false)
    assert.equal(fs.readFileSync(paths.activeAccountFile, "utf8"), "canonical-state")
})

test("reports a fixed temporary file cleanup failure and retries later", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    const temporary = fixedTemporaryFile(paths, "active_account.json")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(source, "legacy-state")
    fs.writeFileSync(temporary, "partial")
    let rejectCleanup = true
    const failingFileSystem = {
        ...fs,
        unlinkSync(target) {
            if (target === temporary && rejectCleanup) {
                rejectCleanup = false
                const error = new Error("simulated temporary cleanup failure")
                error.code = "EACCES"
                throw error
            }
            fs.unlinkSync(target)
        },
    }

    assert.throws(
        () => prepareDataVolume(paths, failingFileSystem),
        /failed to clean up state migration temporary file.*simulated temporary cleanup failure/i,
    )
    assert.equal(fs.existsSync(temporary), true)
    assert.equal(fs.existsSync(source), true)

    prepareDataVolume(paths)
    assert.equal(fs.readFileSync(paths.activeAccountFile, "utf8"), "legacy-state")
    assert.equal(fs.existsSync(temporary), false)
    assert.equal(fs.existsSync(source), false)
})

test("rejects a symbolic link at the fixed temporary path", t => {
    const sandbox = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(sandbox))
    const dataDir = path.join(sandbox, "volume")
    fs.mkdirSync(dataDir)
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    const temporary = fixedTemporaryFile(paths, "active_account.json")
    const linkedFile = path.join(sandbox, "outside-temp")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(source, "legacy-state")
    fs.writeFileSync(linkedFile, "do not remove")
    if (!createHostSymlink(t, linkedFile, temporary)) return

    assert.throws(
        () => prepareDataVolume(paths),
        /state migration temporary path.*regular file/i,
    )
    assert.equal(fs.readFileSync(linkedFile, "utf8"), "do not remove")
    assert.equal(fs.readFileSync(source, "utf8"), "legacy-state")
    assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true)
})

test("rejects a canonical state target directory before deleting the legacy source", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(source, "legacy-state")
    fs.mkdirSync(paths.activeAccountFile)

    assert.throws(
        () => prepareDataVolume(paths),
        /canonical state target.*regular file/i,
    )
    assert.equal(fs.readFileSync(source, "utf8"), "legacy-state")
    assert.equal(fs.lstatSync(paths.activeAccountFile).isDirectory(), true)
})

test("rejects a canonical state target file symlink before deleting the legacy source", t => {
    const sandbox = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(sandbox))
    const dataDir = path.join(sandbox, "volume")
    fs.mkdirSync(dataDir)
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    const outsideFile = path.join(sandbox, "outside-target.json")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(source, "legacy-state")
    fs.writeFileSync(outsideFile, "outside-state")
    if (!createHostSymlink(t, outsideFile, paths.activeAccountFile)) return

    assert.throws(
        () => prepareDataVolume(paths),
        /canonical state target.*regular file/i,
    )
    assert.equal(fs.readFileSync(source, "utf8"), "legacy-state")
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-state")
    assert.equal(fs.lstatSync(paths.activeAccountFile).isSymbolicLink(), true)
})

test("rejects a legacy state source symlink without copying from outside the volume", t => {
    const sandbox = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(sandbox))
    const dataDir = path.join(sandbox, "volume")
    fs.mkdirSync(dataDir)
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const source = path.join(dataDir, "active_account.json")
    const outsideFile = path.join(sandbox, "outside-source.json")
    fs.mkdirSync(paths.stateDir)
    fs.writeFileSync(outsideFile, "outside-state")
    if (!createHostSymlink(t, outsideFile, source)) return

    assert.throws(
        () => prepareDataVolume(paths),
        /legacy state source.*regular file/i,
    )
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-state")
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true)
    assert.equal(fs.existsSync(paths.activeAccountFile), false)
})

test("state write and clear reject file symlinks without modifying external files", t => {
    const cases = [
        {
            name: "canonical-write",
            operation: "defaultSave.saveDefaultSaveTemplate({ schema: 'test', version: 1, data: {} })",
            setup(paths, dataDir, outsideFile) {
                fs.mkdirSync(paths.stateDir)
                fs.writeFileSync(path.join(dataDir, "default_save.json"), "legacy-state")
                return [outsideFile, paths.defaultSaveFile]
            },
            assertProtected(paths, dataDir) {
                assert.equal(fs.readFileSync(path.join(dataDir, "default_save.json"), "utf8"), "legacy-state")
                assert.equal(fs.lstatSync(paths.defaultSaveFile).isSymbolicLink(), true)
            },
        },
        {
            name: "legacy-clear",
            operation: "defaultSave.clearDefaultSaveTemplate()",
            setup(paths, dataDir, outsideFile) {
                fs.mkdirSync(paths.stateDir)
                fs.writeFileSync(paths.defaultSaveFile, "canonical-state")
                return [outsideFile, path.join(dataDir, "default_save.json")]
            },
            assertProtected(paths, dataDir) {
                assert.equal(fs.readFileSync(paths.defaultSaveFile, "utf8"), "canonical-state")
                assert.equal(fs.lstatSync(path.join(dataDir, "default_save.json")).isSymbolicLink(), true)
            },
        },
    ]

    for (const testCase of cases) {
        const sandbox = createTemporaryDirectory(`wdfp-${testCase.name}-`)
        t.after(() => removeTemporaryDirectory(sandbox))
        const dataDir = path.join(sandbox, "volume")
        fs.mkdirSync(dataDir)
        const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
        const outsideFile = path.join(sandbox, "outside.json")
        fs.writeFileSync(outsideFile, "outside-state")
        const [target, linkPath] = testCase.setup(paths, dataDir, outsideFile)
        if (!createHostSymlink(t, target, linkPath)) return
        const script = `
            const defaultSave = require('./src/data/defaultSave')
            ${testCase.operation}
        `

        assert.throws(
            () => execFileSync(
                process.execPath,
                ["-r", "ts-node/register/transpile-only", "-e", script],
                {
                    cwd: projectRoot,
                    env: { ...process.env, DATA_DIR: dataDir },
                    stdio: "pipe",
                },
            ),
            /regular file/i,
        )
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-state")
        testCase.assertProtected(paths, dataDir)
    }
})

test("default save clear and write remove legacy roots without revival", t => {
    const operations = [
        {
            expectedTarget: false,
            source: "assert.equal(defaultSave.clearDefaultSaveTemplate(), true)",
        },
        {
            expectedTarget: true,
            source: "defaultSave.saveDefaultSaveTemplate({ schema: 'starpoint-cn-save', version: 1, data: { fresh: true } })",
        },
    ]

    for (const [index, operation] of operations.entries()) {
        const dataDir = createTemporaryDirectory(`wdfp-default-save-${index}-`)
        t.after(() => removeTemporaryDirectory(dataDir))
        const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
        fs.mkdirSync(paths.stateDir)
        fs.writeFileSync(path.join(dataDir, "default_save.json"), "legacy-root")
        fs.writeFileSync(paths.defaultSaveFile, JSON.stringify({ canonical: true }))
        const script = `
            const assert = require('node:assert/strict')
            const defaultSave = require('./src/data/defaultSave')
            const { prepareDataVolume } = require('./src/runtime/data-paths')
            ${operation.source}
            prepareDataVolume()
        `

        execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", script], {
            cwd: projectRoot,
            env: { ...process.env, DATA_DIR: dataDir },
            stdio: "pipe",
        })

        assert.equal(fs.existsSync(path.join(dataDir, "default_save.json")), false)
        assert.equal(fs.existsSync(paths.defaultSaveFile), operation.expectedTarget)
    }
})

test("rejects a data root that is a regular file or symbolic link", t => {
    const parent = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(parent))
    const fileRoot = path.join(parent, "file-root")
    const realRoot = path.join(parent, "real-root")
    const linkRoot = path.join(parent, "link-root")
    fs.writeFileSync(fileRoot, "not a directory")
    fs.mkdirSync(realRoot)

    assert.throws(
        () => prepareDataVolume(resolveRuntimeDataPaths({ DATA_DIR: fileRoot })),
        /data volume root.*directory/i,
    )
    if (!createHostSymlink(t, realRoot, linkRoot, "dir")) return
    assert.throws(
        () => prepareDataVolume(resolveRuntimeDataPaths({ DATA_DIR: linkRoot })),
        /data volume root.*symbolic link/i,
    )
})

test("rejects a state path that is a regular file or symbolic link", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const filePaths = resolveRuntimeDataPaths({ DATA_DIR: path.join(dataDir, "file-case") })
    fs.mkdirSync(filePaths.dataDir)
    fs.writeFileSync(filePaths.stateDir, "not a directory")
    assert.throws(() => prepareDataVolume(filePaths), /state directory.*directory/i)

    const linkPaths = resolveRuntimeDataPaths({ DATA_DIR: path.join(dataDir, "link-case") })
    fs.mkdirSync(linkPaths.dataDir)
    const linkedDirectory = path.join(dataDir, "linked-state")
    fs.mkdirSync(linkedDirectory)
    if (!createHostSymlink(t, linkedDirectory, linkPaths.stateDir, "dir")) return
    assert.throws(() => prepareDataVolume(linkPaths), /state directory.*symbolic link/i)
})

test("reports unreadable or unwritable data volumes explicitly", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: dataDir })
    const deniedFileSystem = {
        ...fs,
        accessSync(target) {
            const error = new Error(`permission denied: ${target}`)
            error.code = "EACCES"
            throw error
        },
    }

    assert.throws(
        () => prepareDataVolume(paths, deniedFileSystem),
        /data volume.*readable and writable.*permission denied/i,
    )
})

test("state modules honor DATA_DIR when loaded in an isolated process", t => {
    const dataDir = createTemporaryDirectory()
    t.after(() => removeTemporaryDirectory(dataDir))
    const script = `
        const activeAccount = require('./src/data/activeAccount')
        const defaultSave = require('./src/data/defaultSave')
        activeAccount.setActivePlayerId(42)
        defaultSave.saveDefaultSaveTemplate({ schema: 'starpoint-cn-save', version: 1, data: {} })
    `

    execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", script], {
        cwd: projectRoot,
        env: {
            ...process.env,
            DATA_DIR: dataDir,
            WDFP_DATABASE_DIR: path.join(dataDir, "ignored-legacy"),
        },
        stdio: "pipe",
    })

    assert.equal(fs.existsSync(path.join(dataDir, "state", "active_account.json")), true)
    assert.equal(fs.existsSync(path.join(dataDir, "state", "default_save.json")), true)
    assert.equal(fs.existsSync(path.join(dataDir, "active_account.json")), false)
    assert.equal(fs.existsSync(path.join(dataDir, "default_save.json")), false)
})

test("legacy WDFP_DATABASE_DIR tests ignore an inherited DATA_DIR", t => {
    const inheritedDataDir = createTemporaryDirectory("wdfp-inherited-data-volume-")
    t.after(() => removeTemporaryDirectory(inheritedDataDir))

    execFileSync(process.execPath, ["tools/mission_storage.test.cjs"], {
        cwd: projectRoot,
        env: { ...process.env, DATA_DIR: inheritedDataDir },
        stdio: "pipe",
    })

    assert.deepEqual(fs.readdirSync(inheritedDataDir), [])
})
