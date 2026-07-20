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

test("resolves Windows content paths with the injected path API", () => {
    const fsApi = {
        existsSync: () => true,
        realpathSync: value => value,
    }
    const projectRoot = path.win32.resolve("C:\\repo")

    assert.deepEqual(resolveContentPaths({
        projectRoot,
        pathApi: path.win32,
        fsApi,
        env: {
            CDN_DIR: "cache\\cdn-parent",
            CONTENT_STORE_DIR: "D:\\content-store",
            CONTENT_STATE_DIR: "state",
            CONTENT_RUNTIME_DIR: "\\\\server\\share\\runtime",
        },
    }), {
        cdnDir: path.win32.join(projectRoot, "cache", "cdn-parent"),
        cdnRoot: path.win32.join(projectRoot, "cache", "cdn-parent", "cn"),
        contentStoreDir: path.win32.resolve("D:\\content-store"),
        contentStateDir: path.win32.join(projectRoot, "state"),
        contentRuntimeDir: path.win32.resolve("\\\\server\\share\\runtime"),
    })
})

test("resolves all content paths from explicit environment values", () => {
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
        cdnDir: path.posix.join(projectRoot, "var/cdn"),
        cdnRoot: path.posix.join(projectRoot, "var/cdn/cn"),
        contentStoreDir: path.posix.join(projectRoot, "var/content-store"),
        contentStateDir: "/srv/content-state",
        contentRuntimeDir: path.posix.join(projectRoot, "var/runtime"),
    })
})

test("uses project-root-relative defaults without consulting process.cwd", () => {
    const projectRoot = path.posix.resolve("/repo/project")

    assert.deepEqual(resolveContentPaths({ projectRoot, env: {}, ...posixDependencies }), {
        cdnDir: path.posix.join(projectRoot, ".cdn"),
        cdnRoot: path.posix.join(projectRoot, ".cdn/cn"),
        contentStoreDir: path.posix.join(projectRoot, ".content/store"),
        contentStateDir: path.posix.join(projectRoot, ".content/state"),
        contentRuntimeDir: path.posix.join(projectRoot, ".content/runtime"),
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

test("rejects equal or nested lifecycle directories", () => {
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CONTENT_STORE_DIR: ".content/shared",
                CONTENT_STATE_DIR: ".content/shared",
            },
        }),
        /CONTENT_STORE_DIR.*CONTENT_STATE_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { CONTENT_RUNTIME_DIR: ".content/store/runtime" },
        }),
        /CONTENT_STORE_DIR.*CONTENT_RUNTIME_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: { CONTENT_STORE_DIR: ".content" },
        }),
        /CONTENT_STORE_DIR.*CONTENT_STATE_DIR.*equal or nested/,
    )
    assert.throws(
        () => resolveContentPaths({
            projectRoot: "/repo",
            ...posixDependencies,
            env: {
                CDN_DIR: ".content/store/cdn-parent",
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
        /CDN_DIR.*CONTENT_STORE_DIR.*equal or nested/,
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

test("ignores the default content artifact tree", () => {
    const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8")
    assert.match(gitignore, /^\.content\/$/m)
})

test("rejects relative content paths that escape projectRoot", () => {
    for (const variable of [
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
