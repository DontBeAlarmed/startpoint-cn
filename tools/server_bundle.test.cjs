"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")
const { loadServerReleaseContract } = require("./server-bundle/release-contract.cjs")

const projectRoot = path.resolve(__dirname, "..")
const releaseContract = loadServerReleaseContract(projectRoot)
const builderPath = path.join(projectRoot, "tools/server-bundle/build.cjs")
const verifierPath = path.join(projectRoot, "tools/server-bundle/verify.cjs")

function loadImplementations() {
    assert.equal(fs.existsSync(builderPath), true, "server bundle builder must exist")
    assert.equal(fs.existsSync(verifierPath), true, "server bundle verifier must exist")
    return {
        buildServerBundle: require(builderPath).buildServerBundle,
        verifyServerBundle: require(verifierPath).verifyServerBundle,
    }
}

function write(root, relativePath, contents) {
    const destination = path.join(root, ...relativePath.split("/"))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, contents)
}

function temporaryProject(t, { admin = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-bundle-project-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    write(root, "package.json", JSON.stringify({
        name: "starpoint-cn",
        version: "1.0.1",
        engines: { node: ">=20.12.0" },
    }))
    write(root, "package-lock.json", JSON.stringify({
        name: "starpoint-cn",
        version: "1.0.1",
        lockfileVersion: 3,
        packages: {},
    }))
    write(root, "assets/server_release_contract.json", fs.readFileSync(
        path.join(projectRoot, "assets/server_release_contract.json"),
    ))
    write(root, "out/cn-server.js", "console.log('server')\n")
    write(
        root,
        "out/content/sync/entry.js",
        "async function runContentSyncEntry() {}\nmodule.exports = { runContentSyncEntry }\n",
    )
    write(root, "out/lib/runtime.js", "module.exports = 1\n")
    write(root, "out/.tsbuildinfo-cn", "incremental state")
    write(root, "out/.gitignore", "runtime-only-ignore\n")
    write(root, "assets/base.json", "{\"base\":true}\n")
    write(root, "assets/nested/table.json", "{\"table\":true}\n")
    write(root, "assets/.gitignore", "runtime-only-ignore\n")
    write(root, "assets/asset-patch/archive/large.zip", "excluded patch")
    write(root, "LICENSE", "GPL-3.0-or-later\n")
    write(root, "NOTICE", "notice\n")
    write(root, "node_modules/pkg/index.js", "excluded dependency")
    write(root, ".database/wdfp.sqlite", "excluded database")
    write(root, ".content/current.json", "excluded content state")
    write(root, ".cdn/archive.zip", "excluded cdn")
    write(root, "logs/server.log", "excluded log")
    write(root, "apk/client.apk", "excluded apk")

    if (admin) {
        write(root, "web/dist/index.html", "<main>admin</main>\n")
        write(root, "web/dist/assets/admin.js", "console.log('admin')\n")
        write(root, "web/dist/.gitignore", "runtime-only-ignore\n")
    }

    return root
}

function encodeCanonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`
    return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${encodeCanonical(value[key])}`
    )).join(",")}}`
}

function canonicalBuffer(value) {
    return Buffer.from(`${encodeCanonical(value)}\n`, "utf8")
}

function snapshotFiles(root) {
    const files = []

    function visit(absoluteDirectory, relativeDirectory) {
        const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
            .sort((left, right) => Buffer.compare(
                Buffer.from(left.name, "utf8"),
                Buffer.from(right.name, "utf8"),
            ))
        for (const entry of entries) {
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name
            const absolutePath = path.join(absoluteDirectory, entry.name)
            if (entry.isDirectory()) {
                visit(absolutePath, relativePath)
            } else {
                assert.equal(entry.isFile(), true)
                files.push({ path: relativePath, bytes: fs.readFileSync(absolutePath) })
            }
        }
    }

    visit(root, "")
    return files
}

function assertNoFailedBuildOutput(outputRoot) {
    assert.equal(fs.existsSync(outputRoot), false)
    const outputParent = path.dirname(outputRoot)
    const stagingPrefix = `${path.basename(outputRoot)}.building-`
    const staging = fs.existsSync(outputParent)
        ? fs.readdirSync(outputParent).filter(name => name.startsWith(stagingPrefix))
        : []
    assert.deepEqual(staging, [])
}

function assertSelfConsistentV2Bundle(bundleRoot) {
    const manifestPath = path.join(bundleRoot, "server-manifest.json")
    const manifestBytes = fs.readFileSync(manifestPath)
    const manifest = JSON.parse(manifestBytes.toString("utf8"))
    assert.deepEqual(Object.keys(manifest).sort(), [
        "admin",
        "assets",
        "bundleId",
        "entry",
        "files",
        "name",
        "ports",
        "requires",
        "schemaVersion",
        "serverVersion",
    ])
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(Object.hasOwn(manifest, "startup"), false)
    assert.deepEqual(manifestBytes, canonicalBuffer(manifest))

    const { bundleId, ...digestInput } = manifest
    assert.equal(
        bundleId,
        `sha256:${crypto.createHash("sha256").update(canonicalBuffer(digestInput)).digest("hex")}`,
    )
    const snapshot = snapshotFiles(bundleRoot)
    assert.deepEqual(
        snapshot.map(file => file.path).sort(),
        ["server-manifest.json", ...manifest.files.map(file => file.path)].sort(),
    )
    for (const file of manifest.files) {
        const bytes = fs.readFileSync(path.join(bundleRoot, ...file.path.split("/")))
        assert.equal(file.bytes, bytes.length)
        assert.equal(file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"))
    }
}

function rewriteManifest(bundleRoot, mutate) {
    const manifestPath = path.join(bundleRoot, "server-manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    mutate(manifest)
    const { bundleId: _ignored, ...digestInput } = manifest
    manifest.bundleId = `sha256:${crypto.createHash("sha256")
        .update(canonicalBuffer(digestInput)).digest("hex")}`
    fs.writeFileSync(manifestPath, canonicalBuffer(manifest))
    return manifest
}

function buildFixture(t, options) {
    const { buildServerBundle } = loadImplementations()
    const root = temporaryProject(t, options)
    const outputRoot = path.join(root, "dist/server-bundle")
    const manifest = buildServerBundle({ projectRoot: root, outputRoot })
    return { manifest, outputRoot, root }
}

test("builds a canonical reproducible thin server bundle without web/public", async t => {
    const { buildServerBundle } = loadImplementations()
    const root = temporaryProject(t)
    assert.equal(fs.existsSync(path.join(root, "web/public")), false)
    const compiledEntry = require(path.join(root, "out/content/sync/entry.js"))
    assert.deepEqual(Object.keys(compiledEntry), ["runContentSyncEntry"])
    assert.equal(await compiledEntry.runContentSyncEntry(), undefined)
    const firstOutput = path.join(root, "dist/server-bundle")
    const secondOutput = path.join(root, "dist/server-bundle-copy")

    const first = buildServerBundle({ projectRoot: root, outputRoot: firstOutput })
    const firstBytes = fs.readFileSync(path.join(firstOutput, "server-manifest.json"))
    const rebuilt = buildServerBundle({ projectRoot: root, outputRoot: firstOutput })
    const second = buildServerBundle({ projectRoot: root, outputRoot: secondOutput })
    const rebuiltBytes = fs.readFileSync(path.join(firstOutput, "server-manifest.json"))
    const secondBytes = fs.readFileSync(path.join(secondOutput, "server-manifest.json"))

    assert.deepEqual(rebuilt, first)
    assert.deepEqual(second, first)
    assert.deepEqual(rebuiltBytes, firstBytes)
    assert.deepEqual(secondBytes, firstBytes)
    assert.deepEqual(first, {
        admin: { path: "web/dist", required: true },
        assets: {
            minClientAssetVersion: "1.4.54",
            supportedModes: ["client-owned", "local", "remote"],
        },
        bundleId: first.bundleId,
        entry: "out/cn-server.js",
        startup: { localPrepareEntry: "out/content/sync/entry.js" },
        files: first.files,
        name: "starpoint-cn",
        ports: {
            http: releaseContract.defaultPorts.http,
            tcp: releaseContract.defaultPorts.tcp,
            hub: releaseContract.defaultPorts.hub,
        },
        requires: {
            dependencyLock: `sha256:${crypto.createHash("sha256")
                .update(fs.readFileSync(path.join(root, "package-lock.json")))
                .digest("hex")}`,
            minDataSchema: 0,
            node: ">=20.12.0",
            runtimeApi: 1,
            targetDataSchema: releaseContract.currentDataSchema,
        },
        schemaVersion: 3,
        serverVersion: "1.0.1",
    })
    assert.match(first.bundleId, /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(
        first.files.map(file => file.path),
        [
            "LICENSE",
            "NOTICE",
            "assets/base.json",
            "assets/nested/table.json",
            "assets/server_release_contract.json",
            "out/cn-server.js",
            "out/content/sync/entry.js",
            "out/lib/runtime.js",
            "web/dist/assets/admin.js",
            "web/dist/index.html",
        ],
    )
    const { bundleId: _bundleId, ...digestInput } = first
    const { startup: _startup, ...digestWithoutStartup } = digestInput
    assert.notEqual(
        first.bundleId,
        `sha256:${crypto.createHash("sha256").update(canonicalBuffer(digestWithoutStartup)).digest("hex")}`,
    )
    assert.equal(first.files.some(file => file.path === "server-manifest.json"), false)
    assert.equal(first.files.some(file => file.path.endsWith("/.gitignore")), false)
    for (const file of first.files) {
        const bytes = fs.readFileSync(path.join(firstOutput, ...file.path.split("/")))
        assert.equal(file.bytes, bytes.length)
        assert.equal(file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"))
    }
    assert.deepEqual(firstBytes, canonicalBuffer(first))
})

test("requires a complete admin build and excludes legacy pages", t => {
    const { buildServerBundle } = loadImplementations()
    const absentRoot = temporaryProject(t, { admin: false })
    assert.throws(
        () => buildServerBundle({ projectRoot: absentRoot, outputRoot: path.join(absentRoot, "dist/bundle") }),
        /admin.*(?:missing|index)/i,
    )

    const missingIndexRoot = temporaryProject(t)
    fs.unlinkSync(path.join(missingIndexRoot, "web/dist/index.html"))
    assert.throws(
        () => buildServerBundle({ projectRoot: missingIndexRoot, outputRoot: path.join(missingIndexRoot, "dist/bundle") }),
        /admin.*index/i,
    )

    const present = buildFixture(t)
    assert.deepEqual(
        present.manifest.files.filter(file => file.path.startsWith("web/dist/")).map(file => file.path),
        ["web/dist/assets/admin.js", "web/dist/index.html"],
    )
    assert.equal(present.manifest.files.some(file => file.path.startsWith("web/pages/")), false)
})

test("builder rejects unsafe input trees, input-contained output, and unowned output", async t => {
    const { buildServerBundle } = loadImplementations()

    await t.test("symlink", t => {
        const root = temporaryProject(t)
        fs.symlinkSync(path.join(root, "NOTICE"), path.join(root, "assets/link"))
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "dist/bundle") }),
            /symbolic link/i,
        )
    })

    await t.test("special file", t => {
        if (process.platform === "win32") return t.skip("mkfifo is POSIX-only")
        const root = temporaryProject(t)
        const fifo = path.join(root, "assets/runtime.pipe")
        const result = spawnSync("mkfifo", [fifo])
        assert.equal(result.status, 0)
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "dist/bundle") }),
            /regular file|directory/i,
        )
    })

    await t.test("legacy web pages input", t => {
        const root = temporaryProject(t)
        write(root, "web/pages/player.html", "<main>legacy admin</main>\n")
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "dist/bundle") }),
            /web\/pages|legacy admin/i,
        )
    })

    await t.test("output inside input", t => {
        const root = temporaryProject(t)
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "assets/bundle") }),
            /output.*input/i,
        )
    })

    await t.test("missing server entry", t => {
        const root = temporaryProject(t)
        const outputRoot = path.join(root, "dist/bundle")
        fs.unlinkSync(path.join(root, "out/cn-server.js"))
        let thrown
        try {
            buildServerBundle({ projectRoot: root, outputRoot })
        } catch (error) {
            thrown = error
        }
        assert.ok(thrown)
        assert.match(thrown.message, /bundle entry out\/cn-server\.js is missing/i)
        assert.equal(thrown.message.includes(root), false)
        assertNoFailedBuildOutput(outputRoot)
    })

    await t.test("missing local prepare entry", t => {
        const root = temporaryProject(t)
        const outputRoot = path.join(root, "dist/bundle")
        fs.unlinkSync(path.join(root, "out/content/sync/entry.js"))
        let thrown
        try {
            buildServerBundle({ projectRoot: root, outputRoot })
        } catch (error) {
            thrown = error
        }
        assert.ok(thrown)
        assert.match(thrown.message, /local prepare entry out\/content\/sync\/entry\.js is missing/i)
        assert.equal(thrown.message.includes(root), false)
        assertNoFailedBuildOutput(outputRoot)
    })

    await t.test("missing dependency lock", t => {
        const root = temporaryProject(t)
        fs.unlinkSync(path.join(root, "package-lock.json"))
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "dist/bundle") }),
            /dependency|lock/i,
        )
    })

    await t.test("unsupported Node requirement", t => {
        const root = temporaryProject(t)
        const packagePath = path.join(root, "package.json")
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"))
        packageJson.engines.node = "^20"
        fs.writeFileSync(packagePath, JSON.stringify(packageJson))
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot: path.join(root, "dist/bundle") }),
            /Node|metadata/i,
        )
    })

    await t.test("unowned output", t => {
        const root = temporaryProject(t)
        const outputRoot = path.join(root, "dist/bundle")
        write(outputRoot, "personal.txt", "keep me")
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot }),
            /not owned/i,
        )
        assert.equal(fs.readFileSync(path.join(outputRoot, "personal.txt"), "utf8"), "keep me")
    })

    await t.test("self-consistent v2 existing output", t => {
        const root = temporaryProject(t)
        const outputRoot = path.join(root, "dist/bundle")
        buildServerBundle({ projectRoot: root, outputRoot })
        rewriteManifest(outputRoot, manifest => {
            manifest.schemaVersion = 2
            delete manifest.startup
        })
        assertSelfConsistentV2Bundle(outputRoot)
        const before = snapshotFiles(outputRoot)
        assert.throws(
            () => buildServerBundle({ projectRoot: root, outputRoot }),
            /not owned/i,
        )
        assert.deepEqual(snapshotFiles(outputRoot), before)
    })
})

test("verifier detects tampered, extra, and missing files", async t => {
    const { verifyServerBundle } = loadImplementations()

    await t.test("valid bundle", t => {
        const fixture = buildFixture(t)
        assert.deepEqual(verifyServerBundle({ bundleRoot: fixture.outputRoot }), fixture.manifest)
    })

    for (const scenario of ["tampered", "extra", "missing"]) {
        await t.test(scenario, t => {
            const fixture = buildFixture(t)
            if (scenario === "tampered") write(fixture.outputRoot, "assets/base.json", "tampered")
            if (scenario === "extra") write(fixture.outputRoot, "out/extra.js", "extra")
            if (scenario === "missing") fs.unlinkSync(path.join(fixture.outputRoot, "NOTICE"))
            assert.throws(
                () => verifyServerBundle({ bundleRoot: fixture.outputRoot }),
                /hash|size|extra|missing|file set/i,
            )
        })
    }

    for (const requiredFile of ["LICENSE", "NOTICE"]) {
        await t.test(`self-consistent missing ${requiredFile}`, t => {
            const fixture = buildFixture(t)
            fs.unlinkSync(path.join(fixture.outputRoot, requiredFile))
            rewriteManifest(fixture.outputRoot, manifest => {
                manifest.files = manifest.files.filter(file => file.path !== requiredFile)
            })
            assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /LICENSE|NOTICE|required/i)
        })
    }
})

test("verifier rejects a self-consistent altered bundle release contract", t => {
    const { verifyServerBundle } = loadImplementations()
    const fixture = buildFixture(t)
    assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }))

    const contractPath = path.join(
        fixture.outputRoot,
        "assets/server_release_contract.json",
    )
    const bundleContract = JSON.parse(fs.readFileSync(contractPath, "utf8"))
    bundleContract.currentDataSchema = releaseContract.currentDataSchema + 1
    const contractBytes = Buffer.from(`${JSON.stringify(bundleContract)}\n`, "utf8")
    fs.writeFileSync(contractPath, contractBytes)
    rewriteManifest(fixture.outputRoot, manifest => {
        const file = manifest.files.find(
            candidate => candidate.path === "assets/server_release_contract.json",
        )
        file.bytes = contractBytes.length
        file.sha256 = crypto.createHash("sha256").update(contractBytes).digest("hex")
    })

    let thrown
    try {
        verifyServerBundle({ bundleRoot: fixture.outputRoot })
    } catch (error) {
        thrown = error
    }
    assert.ok(thrown)
    assert.match(thrown.message, /bundle release contract/i)
    assert.equal(thrown.message.includes(fixture.outputRoot), false)
})

test("verifier rejects self-consistent files outside the owned bundle roots", async t => {
    const { verifyServerBundle } = loadImplementations()
    for (const relativePath of [
        "node_modules/pkg/index.js",
        ".database/wdfp_data.db",
        ".content/current.json",
        ".cdn/archive.zip",
        "apk/client.apk",
        "assets/asset-patch/archive/patch.zip",
        "assets/.gitignore",
        "out/.gitignore",
        "web/dist/.gitignore",
        "web/public/injected.txt",
        "web/pages/player.html",
        "out/.tsbuildinfo-cn",
    ]) {
        await t.test(relativePath, t => {
            const fixture = buildFixture(t)
            if (fixture.manifest.files.some(file => file.path === relativePath)) {
                fs.unlinkSync(path.join(fixture.outputRoot, ...relativePath.split("/")))
                rewriteManifest(fixture.outputRoot, manifest => {
                    manifest.files = manifest.files.filter(file => file.path !== relativePath)
                })
            }
            const contents = Buffer.from(`forbidden:${relativePath}`)
            write(fixture.outputRoot, relativePath, contents)
            rewriteManifest(fixture.outputRoot, manifest => {
                manifest.files.push({
                    path: relativePath,
                    bytes: contents.length,
                    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
                })
                manifest.files.sort((left, right) => Buffer.compare(
                    Buffer.from(left.path, "utf8"),
                    Buffer.from(right.path, "utf8"),
                ))
            })
            assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /owned|allowed|bundle path/i)
        })
    }
})

test("verifier rejects malicious, duplicate, and unstably ordered manifest paths", async t => {
    const { verifyServerBundle } = loadImplementations()

    const scenarios = [
        ["path escape", manifest => { manifest.files[0].path = "../outside" }, /unsafe|path/i],
        ["absolute path", manifest => { manifest.files[0].path = "/outside" }, /unsafe|path/i],
        ["backslash", manifest => { manifest.files[0].path = "out\\escape.js" }, /unsafe|path/i],
        ["manifest recursion", manifest => { manifest.files[0].path = "server-manifest.json" }, /manifest|path/i],
        ["duplicate", manifest => { manifest.files[1] = { ...manifest.files[0] } }, /duplicate|unique/i],
        ["wrong order", manifest => { manifest.files.reverse() }, /sort|order/i],
    ]

    for (const [name, mutate, expected] of scenarios) {
        await t.test(name, t => {
            const fixture = buildFixture(t)
            rewriteManifest(fixture.outputRoot, mutate)
            let thrown
            try {
                verifyServerBundle({ bundleRoot: fixture.outputRoot })
            } catch (error) {
                thrown = error
            }
            assert.ok(thrown)
            assert.match(thrown.message, expected)
            assert.equal(thrown.message.includes(fixture.outputRoot), false)
        })
    }
})

test("verifier rejects symlinks and non-canonical or shape-invalid manifests", async t => {
    const { verifyServerBundle } = loadImplementations()

    await t.test("symlink", t => {
        const fixture = buildFixture(t)
        const target = path.join(fixture.outputRoot, "NOTICE")
        fs.unlinkSync(target)
        fs.symlinkSync(path.join(fixture.outputRoot, "LICENSE"), target)
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /symbolic link/i)
    })

    await t.test("non-canonical JSON", t => {
        const fixture = buildFixture(t)
        const manifestPath = path.join(fixture.outputRoot, "server-manifest.json")
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /canonical/i)
    })

    await t.test("extra manifest field", t => {
        const fixture = buildFixture(t)
        rewriteManifest(fixture.outputRoot, manifest => { manifest.unexpected = true })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /exact|field|key/i)
    })

    const startupShapes = [
        ["missing startup", manifest => { delete manifest.startup }, /manifest.*exact keys|startup/i],
        ["startup is null", manifest => { manifest.startup = null }, /startup.*object/i],
        ["startup is an array", manifest => { manifest.startup = [] }, /startup.*object/i],
        ["startup is a string", manifest => { manifest.startup = "out\/content\/sync\/entry.js" }, /startup.*object/i],
        ["startup missing localPrepareEntry", manifest => { manifest.startup = {} }, /startup.*exact keys/i],
        ["startup has an unknown key", manifest => {
            manifest.startup = {
                localPrepareEntry: "out/content/sync/entry.js",
                unknown: true,
            }
        }, /startup.*exact keys/i],
    ]
    for (const [name, mutate, expected] of startupShapes) {
        await t.test(name, t => {
            const fixture = buildFixture(t)
            rewriteManifest(fixture.outputRoot, mutate)
            assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), expected)
        })
    }

    const localPrepareEntries = [
        ["unsafe local prepare entry", "../content/sync/entry.js", /startup\.localPrepareEntry.*unsafe/i],
        ["non-fixed local prepare entry", "out/content/sync/other.js", /startup\.localPrepareEntry must be out\/content\/sync\/entry\.js/i],
    ]
    for (const [name, localPrepareEntry, expected] of localPrepareEntries) {
        await t.test(name, t => {
            const fixture = buildFixture(t)
            rewriteManifest(fixture.outputRoot, manifest => {
                manifest.startup = { localPrepareEntry }
            })
            assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), expected)
        })
    }

    await t.test("local prepare entry is not listed in files", t => {
        const fixture = buildFixture(t)
        rewriteManifest(fixture.outputRoot, manifest => {
            manifest.files = manifest.files.filter(file => (
                file.path !== "out/content/sync/entry.js"
            ))
        })
        assert.throws(
            () => verifyServerBundle({ bundleRoot: fixture.outputRoot }),
            /startup\.localPrepareEntry must be listed in files/i,
        )
    })

    for (const schemaVersion of [2, 4]) {
        await t.test(`schema version ${schemaVersion}`, t => {
            const fixture = buildFixture(t)
            rewriteManifest(fixture.outputRoot, manifest => { manifest.schemaVersion = schemaVersion })
            assert.throws(
                () => verifyServerBundle({ bundleRoot: fixture.outputRoot }),
                /schemaVersion must be 3/,
            )
        })
    }
})

test("verifier enforces runtime, Node, data schema, entry, and admin compatibility", async t => {
    const { verifyServerBundle } = loadImplementations()

    await t.test("runtime API", t => {
        const fixture = buildFixture(t)
        rewriteManifest(fixture.outputRoot, manifest => { manifest.requires.runtimeApi = 2 })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /runtimeApi/i)
    })

    await t.test("Runtime Pack dependency lock", t => {
        const fixture = buildFixture(t)
        assert.doesNotThrow(() => verifyServerBundle({
            bundleRoot: fixture.outputRoot,
            dependencyLock: fixture.manifest.requires.dependencyLock,
        }))
        assert.throws(() => verifyServerBundle({
            bundleRoot: fixture.outputRoot,
            dependencyLock: `sha256:${"f".repeat(64)}`,
        }), /dependencyLock|Runtime Pack/i)
        rewriteManifest(fixture.outputRoot, manifest => {
            manifest.requires.dependencyLock = "invalid"
        })
        assert.throws(
            () => verifyServerBundle({ bundleRoot: fixture.outputRoot }),
            /dependencyLock/i,
        )
    })

    await t.test("Node version", t => {
        const fixture = buildFixture(t)
        rewriteManifest(fixture.outputRoot, manifest => { manifest.requires.node = ">=999.0.0" })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /Node/i)
        rewriteManifest(fixture.outputRoot, manifest => { manifest.requires.node = "^20" })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /Node/i)
    })

    await t.test("data schema", t => {
        const fixture = buildFixture(t)
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 0 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 4 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 5 }))
        assert.throws(
            () => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: -1 }),
            /data schema/i,
        )
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 6 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 12 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 13 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 14 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 15 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 16 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 17 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 19 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 20 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 21 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 22 }))
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 23 }))
        assert.doesNotThrow(() => verifyServerBundle({
            bundleRoot: fixture.outputRoot,
            dataSchema: releaseContract.currentDataSchema,
        }))
        assert.throws(
            () => verifyServerBundle({ bundleRoot: fixture.outputRoot, dataSchema: 25 }),
            /data schema/i,
        )
        rewriteManifest(fixture.outputRoot, manifest => { manifest.requires.minDataSchema = 2 })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /data schema/i)

        const targetFixture = buildFixture(t)
        rewriteManifest(targetFixture.outputRoot, manifest => {
            manifest.requires.targetDataSchema = 25
        })
        assert.throws(() => verifyServerBundle({ bundleRoot: targetFixture.outputRoot }), /data schema/i)
    })

    await t.test("entry", t => {
        const fixture = buildFixture(t)
        fs.unlinkSync(path.join(fixture.outputRoot, "out/cn-server.js"))
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /entry|missing/i)
    })

    await t.test("admin cannot be marked optional", t => {
        const fixture = buildFixture(t)
        rewriteManifest(fixture.outputRoot, manifest => { manifest.admin.required = false })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /admin/i)
    })

    await t.test("required admin present", t => {
        const fixture = buildFixture(t)
        assert.doesNotThrow(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }))
    })

    await t.test("required admin without index", t => {
        const fixture = buildFixture(t)
        fs.unlinkSync(path.join(fixture.outputRoot, "web/dist/index.html"))
        rewriteManifest(fixture.outputRoot, manifest => {
            manifest.admin.required = true
            manifest.files = manifest.files.filter(file => file.path !== "web/dist/index.html")
        })
        assert.throws(() => verifyServerBundle({ bundleRoot: fixture.outputRoot }), /admin.*index/i)
    })

})

test("verifier keeps traversal and validation independent from the builder", () => {
    loadImplementations()
    const source = fs.readFileSync(verifierPath, "utf8")
    assert.doesNotMatch(source, /require\([^)]*(?:build|builder)/i)
    const dependencies = [...source.matchAll(/require\(["']([^"']+)["']\)/g)]
        .map(match => match[1])
        .filter(specifier => !specifier.startsWith("node:"))
    assert.deepEqual(dependencies, [
        "./canonical-json.cjs",
        "./release-contract.cjs",
    ])
})
