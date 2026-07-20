const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    resolveCnCdnRoot,
    resolveContentPaths,
} = require("../src/content/paths")

test("resolves the CN CDN root from absolute and project-relative paths", () => {
    assert.equal(resolveCnCdnRoot("/srv/wf-cdn", "/repo"), "/srv/wf-cdn/cn")
    assert.equal(resolveCnCdnRoot(".cdn", "/repo"), "/repo/.cdn/cn")
    assert.equal(resolveCnCdnRoot("/srv/wf-cdn/cn", "/repo"), "/srv/wf-cdn/cn")
    assert.equal(resolveCnCdnRoot("/srv/wf-cdn/cn/", "/repo"), "/srv/wf-cdn/cn")
})

test("rejects empty CDN paths", () => {
    assert.throws(() => resolveCnCdnRoot("", "/repo"), /CDN_DIR/)
    assert.throws(() => resolveCnCdnRoot("   ", "/repo"), /CDN_DIR/)
})

test("normalizes relative CDN paths without allowing project-root escape", () => {
    assert.equal(
        resolveCnCdnRoot("cache/../.cdn", "/repo"),
        "/repo/.cdn/cn",
    )
    assert.throws(
        () => resolveCnCdnRoot("../outside", "/repo"),
        /outside projectRoot/,
    )
    assert.equal(
        resolveCnCdnRoot("/external/wf-cdn", "/repo"),
        "/external/wf-cdn/cn",
    )
})

test("resolves all content paths from explicit environment values", () => {
    const projectRoot = path.resolve("/repo/project")
    const paths = resolveContentPaths({
        projectRoot,
        env: {
            CDN_DIR: "var/cdn",
            CONTENT_STORE_DIR: "var/content-store",
            CONTENT_STATE_DIR: "/srv/content-state",
            CONTENT_RUNTIME_DIR: "var/runtime",
        },
    })

    assert.deepEqual(paths, {
        cdnRoot: path.join(projectRoot, "var/cdn/cn"),
        contentStoreDir: path.join(projectRoot, "var/content-store"),
        contentStateDir: "/srv/content-state",
        contentRuntimeDir: path.join(projectRoot, "var/runtime"),
    })
})

test("uses project-root-relative defaults without consulting process.cwd", () => {
    const projectRoot = path.resolve("/repo/project")

    assert.deepEqual(resolveContentPaths({ projectRoot, env: {} }), {
        cdnRoot: path.join(projectRoot, ".cdn/cn"),
        contentStoreDir: path.join(projectRoot, ".content/store"),
        contentStateDir: path.join(projectRoot, ".content/state"),
        contentRuntimeDir: path.join(projectRoot, ".content/runtime"),
    })
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
                env: { [variable]: "../outside" },
            }),
            new RegExp(`${variable}.*outside projectRoot`),
        )
    }
})
