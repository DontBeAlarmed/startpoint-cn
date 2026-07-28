const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    resolveCnCdnRoot,
    resolveContentPaths,
} = require("../src/content/paths")

const identityFsApi = {
    existsSync: () => true,
    realpathSync: value => value,
}
const posixDependencies = { fsApi: identityFsApi, pathApi: path.posix }

function createHostDirectorySymlink(t, target, linkPath) {
    try {
        fs.symlinkSync(target, linkPath, "dir")
        return true
    } catch (error) {
        if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
            t.skip("directory symlink creation is unavailable on this Windows host")
            return false
        }
        throw error
    }
}

test("resolves the CN CDN root from absolute and project-relative paths", () => {
    assert.equal(
        resolveCnCdnRoot("/srv/wf-cdn", "/repo", posixDependencies),
        path.posix.join("/srv/wf-cdn", "cn"),
    )
    assert.equal(
        resolveCnCdnRoot(".cdn", "/repo", posixDependencies),
        path.posix.join(path.posix.resolve("/repo"), ".cdn", "cn"),
    )
})

test("rejects a CDN_DIR that already names the CN child", () => {
    assert.throws(
        () => resolveCnCdnRoot("/srv/wf-cdn/cn", "/repo", posixDependencies),
        /CDN_DIR.*parent directory/i,
    )
    assert.throws(
        () => resolveCnCdnRoot("/srv/wf-cdn/cn/", "/repo", posixDependencies),
        /CDN_DIR.*parent directory/i,
    )
})

test("rejects empty CDN paths", () => {
    assert.throws(() => resolveCnCdnRoot("", "/repo", posixDependencies), /CDN_DIR/)
    assert.throws(() => resolveCnCdnRoot("   ", "/repo", posixDependencies), /CDN_DIR/)
})

test("normalizes relative CDN paths without allowing project-root escape", () => {
    assert.equal(
        resolveCnCdnRoot("cache/../.cdn", "/repo", posixDependencies),
        path.posix.join(path.posix.resolve("/repo"), ".cdn", "cn"),
    )
    assert.throws(
        () => resolveCnCdnRoot("../outside", "/repo", posixDependencies),
        /outside projectRoot/,
    )
    assert.equal(
        resolveCnCdnRoot("/external/wf-cdn", "/repo", posixDependencies),
        path.posix.join("/external/wf-cdn", "cn"),
    )
    assert.equal(
        resolveCnCdnRoot("C:cache", "/repo", posixDependencies),
        path.posix.join(path.posix.resolve("/repo"), "C:cache", "cn"),
    )
})

test("supports fully-qualified Windows drive and UNC paths", () => {
    const fsApi = {
        existsSync: () => true,
        realpathSync: value => value,
    }
    const dependencies = { fsApi, pathApi: path.win32 }
    const projectRoot = path.win32.resolve("C:\\repo")

    assert.equal(
        resolveCnCdnRoot("D:\\wf-cdn", projectRoot, dependencies),
        path.win32.join("D:\\wf-cdn", "cn"),
    )
    assert.equal(
        resolveCnCdnRoot("\\\\server\\share\\wf-cdn", projectRoot, dependencies),
        path.win32.join("\\\\server\\share\\wf-cdn", "cn"),
    )
    assert.throws(
        () => resolveCnCdnRoot("\\cdn", projectRoot, dependencies),
        /fully-qualified absolute|root-relative/i,
    )
})

test("uses split modern defaults rooted at the supplied project", () => {
    const projectRoot = path.posix.resolve("/repo/project")

    assert.deepEqual(resolveContentPaths({ projectRoot, env: {}, ...posixDependencies }), {
        layout: "modern",
        cdnDir: path.posix.join(projectRoot, ".cdn"),
        cdnRoot: path.posix.join(projectRoot, ".cdn/cn"),
        patchesRoot: path.posix.join(projectRoot, ".cdn/patches"),
        contentRootDir: path.posix.join(projectRoot, ".content"),
        contentStoreDir: path.posix.join(projectRoot, ".database/content/store"),
        contentStateDir: path.posix.join(projectRoot, ".database/state/content"),
        contentRuntimeDir: path.posix.join(projectRoot, "assets"),
    })
})

test("derives patchesRoot from the configured CDN parent", () => {
    const projectRoot = path.posix.resolve("/repo/project")

    assert.equal(
        resolveContentPaths({ projectRoot, env: {}, ...posixDependencies }).patchesRoot,
        path.posix.join(projectRoot, ".cdn", "patches"),
    )
    assert.equal(
        resolveContentPaths({
            projectRoot,
            env: { CDN_DIR: "/srv/wf-cdn" },
            ...posixDependencies,
        }).patchesRoot,
        "/srv/wf-cdn/patches",
    )
})

test("uses DATA_DIR before WDFP_DATABASE_DIR for modern store and state", () => {
    const paths = resolveContentPaths({
        projectRoot: "/repo",
        ...posixDependencies,
        env: {
            DATA_DIR: "/srv/data",
            WDFP_DATABASE_DIR: "/srv/legacy-data",
        },
    })

    assert.equal(paths.layout, "modern")
    assert.equal(paths.contentStoreDir, "/srv/data/content/store")
    assert.equal(paths.contentStateDir, "/srv/data/state/content")
})

test("falls back to WDFP_DATABASE_DIR for modern store and state", () => {
    const paths = resolveContentPaths({
        projectRoot: "/repo",
        ...posixDependencies,
        env: { WDFP_DATABASE_DIR: "/srv/legacy-data" },
    })

    assert.equal(paths.contentStoreDir, "/srv/legacy-data/content/store")
    assert.equal(paths.contentStateDir, "/srv/legacy-data/state/content")
})

test("resolves relative DATA_DIR and WDFP_DATABASE_DIR from projectRoot", () => {
    for (const variable of ["DATA_DIR", "WDFP_DATABASE_DIR"]) {
        const paths = resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { [variable]: "var/data" },
        })

        assert.equal(paths.contentStoreDir, "/repo/var/data/content/store")
        assert.equal(paths.contentStateDir, "/repo/var/data/state/content")
    }
})

test("resolves explicit modern store, state, and bundled runtime roots", () => {
    const projectRoot = path.posix.resolve("/repo/project")
    const paths = resolveContentPaths({
        projectRoot,
        ...posixDependencies,
        env: {
            CDN_DIR: "var/cdn",
            CONTENT_STORE_DIR: "var/content-store",
            CONTENT_STATE_DIR: "/srv/content-state",
            CONTENT_RUNTIME_DIR: "var/runtime",
        },
    })

    assert.deepEqual(paths, {
        layout: "modern",
        cdnDir: path.posix.join(projectRoot, "var/cdn"),
        cdnRoot: path.posix.join(projectRoot, "var/cdn/cn"),
        patchesRoot: path.posix.join(projectRoot, "var/cdn/patches"),
        contentRootDir: path.posix.join(projectRoot, ".content"),
        contentStoreDir: path.posix.join(projectRoot, "var/content-store"),
        contentStateDir: "/srv/content-state",
        contentRuntimeDir: path.posix.join(projectRoot, "var/runtime"),
    })
})

test("uses an explicit CONTENT_DIR as the legacy store and state root", () => {
    const projectRoot = path.posix.resolve("/repo/project")
    const paths = resolveContentPaths({
        projectRoot,
        ...posixDependencies,
        env: { CONTENT_DIR: "/srv/content" },
    })

    assert.deepEqual(paths, {
        layout: "legacy",
        cdnDir: path.posix.join(projectRoot, ".cdn"),
        cdnRoot: path.posix.join(projectRoot, ".cdn/cn"),
        patchesRoot: path.posix.join(projectRoot, ".cdn/patches"),
        contentRootDir: "/srv/content",
        contentStoreDir: "/srv/content",
        contentStateDir: "/srv/content",
        contentRuntimeDir: path.posix.join(projectRoot, "assets"),
    })
})

test("allows CONTENT_RUNTIME_DIR to be configured independently in legacy layout", () => {
    const paths = resolveContentPaths({
        projectRoot: "/repo",
        ...posixDependencies,
        env: {
            CONTENT_DIR: "/srv/content",
            CONTENT_RUNTIME_DIR: "/srv/bundled-runtime",
        },
    })

    assert.equal(paths.layout, "legacy")
    assert.equal(paths.contentRuntimeDir, "/srv/bundled-runtime")
})

test("rejects ambiguous CONTENT_DIR and split-directory configuration", () => {
    for (const variable of ["CONTENT_STORE_DIR", "CONTENT_STATE_DIR"]) {
        assert.throws(
            () => resolveContentPaths({
                projectRoot: "/repo",
                ...posixDependencies,
                env: {
                    CONTENT_DIR: "/srv/content",
                    [variable]: `/srv/${variable.toLowerCase()}`,
                },
            }),
            new RegExp(`CONTENT_DIR.*${variable}.*cannot|${variable}.*CONTENT_DIR.*cannot`, "i"),
        )
    }
})

test("resolves Windows and UNC roots with the injected path API", () => {
    const projectRoot = path.win32.resolve("C:\\repo")
    const dependencies = { fsApi: identityFsApi, pathApi: path.win32 }

    assert.deepEqual(resolveContentPaths({
        projectRoot,
        ...dependencies,
        env: {
            CDN_DIR: "cache\\cdn-parent",
            DATA_DIR: "D:\\data",
            CONTENT_RUNTIME_DIR: "\\\\server\\share\\runtime",
        },
    }), {
        layout: "modern",
        cdnDir: path.win32.join(projectRoot, "cache", "cdn-parent"),
        cdnRoot: path.win32.join(projectRoot, "cache", "cdn-parent", "cn"),
        patchesRoot: path.win32.join(projectRoot, "cache", "cdn-parent", "patches"),
        contentRootDir: path.win32.join(projectRoot, ".content"),
        contentStoreDir: path.win32.join("D:\\data", "content", "store"),
        contentStateDir: path.win32.join("D:\\data", "state", "content"),
        contentRuntimeDir: path.win32.resolve("\\\\server\\share\\runtime"),
    })
})

test("rejects relative paths that physically escape through a symbolic link", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-paths-"))
    const projectRoot = path.join(sandbox, "project")
    const externalRoot = path.join(sandbox, "external")
    fs.mkdirSync(projectRoot)
    fs.mkdirSync(externalRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    if (!createHostDirectorySymlink(t, externalRoot, path.join(projectRoot, "outside"))) return

    for (const [variable, value] of [
        ["CDN_DIR", "outside/cdn-parent"],
        ["CONTENT_DIR", "outside/content"],
        ["CONTENT_STORE_DIR", "outside/store"],
        ["CONTENT_STATE_DIR", "outside/state"],
        ["CONTENT_RUNTIME_DIR", "outside/runtime"],
    ]) {
        assert.throws(
            () => resolveContentPaths({
                projectRoot,
                env: { [variable]: value },
            }),
            new RegExp(`${variable}.*physically outside projectRoot`),
        )
    }
})

test("rejects default modern data paths that escape through a .database symlink", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-default-data-escape-"))
    const projectRoot = path.join(sandbox, "project")
    const externalRoot = path.join(sandbox, "external")
    fs.mkdirSync(projectRoot)
    fs.mkdirSync(externalRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    if (!createHostDirectorySymlink(t, externalRoot, path.join(projectRoot, ".database"))) return

    assert.throws(
        () => resolveContentPaths({ projectRoot, env: {} }),
        /CONTENT_STORE_DIR.*physically outside projectRoot/i,
    )
})

test("rejects relative DATA_DIR and WDFP_DATABASE_DIR symlink escapes", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-relative-data-escape-"))
    const projectRoot = path.join(sandbox, "project")
    const externalRoot = path.join(sandbox, "external")
    fs.mkdirSync(projectRoot)
    fs.mkdirSync(externalRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))

    for (const variable of ["DATA_DIR", "WDFP_DATABASE_DIR"]) {
        const relativeRoot = variable.toLowerCase()
        if (!createHostDirectorySymlink(t, externalRoot, path.join(projectRoot, relativeRoot))) return
        assert.throws(
            () => resolveContentPaths({
                projectRoot,
                env: { [variable]: relativeRoot },
            }),
            new RegExp(`${variable}.*physically outside projectRoot`, "i"),
        )
    }
})

test("allows an explicit absolute external DATA_DIR while preserving path isolation", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-external-data-"))
    const projectRoot = path.join(sandbox, "project")
    const externalDataRoot = path.join(sandbox, "external-data")
    fs.mkdirSync(projectRoot)
    fs.mkdirSync(externalDataRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))

    const paths = resolveContentPaths({
        projectRoot,
        env: { DATA_DIR: externalDataRoot },
    })
    assert.equal(paths.contentStoreDir, path.join(externalDataRoot, "content", "store"))
    assert.equal(paths.contentStateDir, path.join(externalDataRoot, "state", "content"))

    fs.mkdirSync(path.join(projectRoot, "assets"))
    fs.mkdirSync(path.join(externalDataRoot, "content"))
    if (!createHostDirectorySymlink(
        t,
        path.join(projectRoot, "assets"),
        path.join(externalDataRoot, "content", "store"),
    )) return
    assert.throws(
        () => resolveContentPaths({
            projectRoot,
            env: { DATA_DIR: externalDataRoot },
        }),
        /CONTENT_STORE_DIR.*CONTENT_RUNTIME_DIR.*equal or nested/i,
    )
})

test("rejects dangling symbolic links in relative content paths", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-dangling-paths-"))
    const projectRoot = path.join(sandbox, "project")
    const missingTarget = path.join(sandbox, "outside", "future-content")
    const linkPath = path.join(projectRoot, "content-link")
    fs.mkdirSync(projectRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    try {
        fs.symlinkSync(missingTarget, linkPath, "dir")
    } catch (error) {
        if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
            t.skip("directory symlink creation is unavailable on this Windows host")
            return
        }
        throw error
    }

    assert.throws(
        () => resolveContentPaths({
            projectRoot,
            env: { CONTENT_DIR: "content-link" },
        }),
        /CONTENT_DIR.*dangling symbolic link|dangling symbolic link.*CONTENT_DIR/i,
    )
})

test("rejects equal or nested modern content directories", () => {
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CONTENT_STORE_DIR: "var/shared",
                CONTENT_STATE_DIR: "var/shared",
            },
        }),
        /CONTENT_STORE_DIR.*CONTENT_STATE_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CONTENT_STORE_DIR: "var/store",
                CONTENT_RUNTIME_DIR: "var/store/runtime",
            },
        }),
        /CONTENT_STORE_DIR.*CONTENT_RUNTIME_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { DATA_DIR: "/repo/.content" },
        }),
        /CONTENT_DIR.*CONTENT_STORE_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CDN_DIR: "var/store/cdn-parent",
                CONTENT_STORE_DIR: "var/store",
            },
        }),
        /CDN_DIR.*CONTENT_STORE_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { CDN_DIR: ".content" },
        }),
        /CDN_DIR.*CONTENT_DIR.*equal or nested/,
    )
})

test("isolates the legacy content root from CDN and bundled runtime", () => {
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { CONTENT_DIR: ".cdn/content" },
        }),
        /CDN_DIR.*CONTENT_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { CDN_DIR: ".content/cdn" },
        }),
        /CDN_DIR.*CONTENT_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CONTENT_DIR: ".content",
                CONTENT_RUNTIME_DIR: ".content/runtime",
            },
        }),
        /CONTENT_DIR.*CONTENT_RUNTIME_DIR.*equal or nested/,
    )
})

test("rejects lifecycle directories that overlap through symbolic-link aliases", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-overlap-"))
    const projectRoot = path.join(sandbox, "project")
    const sharedRoot = path.join(projectRoot, "shared")
    fs.mkdirSync(sharedRoot, { recursive: true })
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    if (!createHostDirectorySymlink(t, sharedRoot, path.join(projectRoot, "shared-alias"))) return

    assert.throws(
        () => resolveContentPaths({
            projectRoot,
            env: {
                CONTENT_STORE_DIR: "shared/data",
                CONTENT_STATE_DIR: "shared-alias/data",
            },
        }),
        /CONTENT_STORE_DIR.*CONTENT_STATE_DIR.*equal or nested/,
    )
})

test("resolving content paths does not create directories", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-path-resolution-"))
    const projectRoot = path.join(sandbox, "project")
    fs.mkdirSync(projectRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))

    const before = fs.readdirSync(projectRoot)
    const paths = resolveContentPaths({ projectRoot, env: {} })

    assert.deepEqual(fs.readdirSync(projectRoot), before)
    assert.equal(paths.contentRootDir, path.join(projectRoot, ".content"))
    assert.equal(paths.contentStoreDir, path.join(projectRoot, ".database", "content", "store"))
    assert.equal(paths.contentStateDir, path.join(projectRoot, ".database", "state", "content"))
    assert.equal(paths.contentRuntimeDir, path.join(projectRoot, "assets"))
    for (const directory of [
        paths.contentRootDir,
        paths.contentStoreDir,
        paths.contentStateDir,
        paths.contentRuntimeDir,
    ]) {
        assert.equal(fs.existsSync(directory), false)
    }
})

test("ignores the default content artifact tree", () => {
    const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8")
    assert.match(gitignore, /^\.content\/$/m)
})

test("rejects relative content paths that escape projectRoot", () => {
    for (const variable of [
        "CONTENT_DIR",
        "CONTENT_STORE_DIR",
        "CONTENT_STATE_DIR",
        "CONTENT_RUNTIME_DIR",
    ]) {
        assert.throws(
            () => resolveContentPaths({
                projectRoot: "/repo",
                ...posixDependencies,
                env: { [variable]: "../outside" },
            }),
            new RegExp(`${variable}.*outside projectRoot`),
        )
    }
})
