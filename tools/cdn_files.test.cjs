"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const cdnFilesPlugin = require("../src/routes/cn/cdnFiles").default
const { parseHttpByteRange } = require("../src/routes/cn/httpRange")

const SHA256 = "a".repeat(64)

function archive(relativePath, compressedBytes, order = 1) {
    return {
        relativePath,
        compressedBytes,
        sha256: SHA256,
        layer: "common",
        order,
    }
}

function snapshot(archives) {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 10,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([{
                fromVersion: null,
                toVersion: "1.4.0",
                platform: "android",
                assetSizeKind: "fulfill",
                archives: Object.freeze(archives),
            }]),
        }),
    })
}

async function waitForBalancedHandles(observer) {
    for (let attempt = 0; attempt < 100 && observer.opened !== observer.closed; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observer.closed, observer.opened)
}

async function captureUnhandledErrors(run) {
    const baseline = {
        uncaughtException: process.listenerCount("uncaughtException"),
        unhandledRejection: process.listenerCount("unhandledRejection"),
    }
    const errors = []
    const onError = error => errors.push(error)
    process.on("uncaughtException", onError)
    process.on("unhandledRejection", onError)
    let failure
    try {
        await run()
        await new Promise(resolve => setImmediate(resolve))
    } catch (error) {
        failure = error
    } finally {
        process.off("uncaughtException", onError)
        process.off("unhandledRejection", onError)
    }
    assert.equal(process.listenerCount("uncaughtException"), baseline.uncaughtException)
    assert.equal(process.listenerCount("unhandledRejection"), baseline.unhandledRejection)
    assert.deepEqual(errors, [])
    if (failure) throw failure
}

async function createFixture(t, options = {}) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cn-cdn-files-"))
    const cdnRoot = path.join(sandbox, "cdn")
    const patchUploadRoot = path.join(sandbox, "patch-upload")
    const contentStateDir = path.join(sandbox, "must-not-exist")
    const outsideRoot = path.join(sandbox, "outside")
    const zipBytes = Buffer.from("0123456789")

    fs.mkdirSync(path.join(cdnRoot, "archive-common-full"), { recursive: true })
    fs.mkdirSync(path.join(cdnRoot, "EntityLists"), { recursive: true })
    fs.mkdirSync(path.join(cdnRoot, "objects"), { recursive: true })
    fs.mkdirSync(path.join(patchUploadRoot, "ab"), { recursive: true })
    fs.mkdirSync(outsideRoot, { recursive: true })
    fs.writeFileSync(path.join(cdnRoot, "archive-common-full", "base.zip"), zipBytes)
    fs.writeFileSync(path.join(cdnRoot, "archive-common-full", "extra.zip"), "extra")
    fs.writeFileSync(path.join(cdnRoot, "EntityLists", "android_medium.csv"), "entities")
    fs.writeFileSync(path.join(cdnRoot, "EntityLists", "empty.csv"), "")
    fs.writeFileSync(path.join(cdnRoot, "objects", "ordinary.bin"), "ordinary")
    fs.writeFileSync(path.join(cdnRoot, "objects", "large.bin"), Buffer.alloc(256 * 1024, 0x31))
    fs.writeFileSync(path.join(patchUploadRoot, "ab", "patch-hash"), "patched")
    fs.writeFileSync(path.join(outsideRoot, "outside.bin"), "outside")
    fs.writeFileSync(path.join(outsideRoot, "outside.zip"), zipBytes)
    fs.symlinkSync(path.join(outsideRoot, "outside.bin"), path.join(cdnRoot, "objects", "outside.bin"))
    fs.symlinkSync(path.join(outsideRoot, "outside.zip"), path.join(cdnRoot, "archive-common-full", "outside.zip"))
    options.setup?.({ cdnRoot, outsideRoot, zipBytes })

    const observer = { opened: 0, closed: 0 }
    const app = Fastify({ logger: false })
    options.configureApp?.(app)
    const previousContentStateDir = process.env.CONTENT_STATE_DIR
    process.env.CONTENT_STATE_DIR = contentStateDir
    app.register(cdnFilesPlugin, {
        getSnapshot: () => snapshot(options.archives?.({ cdnRoot, outsideRoot, zipBytes }) ?? [
            archive("archive-common-full/base.zip", zipBytes.length),
            archive("archive-common-full/outside.zip", zipBytes.length, 2),
        ]),
        paths: { cdnRoot },
        patchUploadRoot,
        ...(options.fileSystemFactory
            ? { fileSystem: options.fileSystemFactory({ cdnRoot }) }
            : {}),
        handleObserver: {
            opened: () => { observer.opened++ },
            closed: () => { observer.closed++ },
        },
    })

    try {
        await app.ready()
    } finally {
        if (previousContentStateDir === undefined) delete process.env.CONTENT_STATE_DIR
        else process.env.CONTENT_STATE_DIR = previousContentStateDir
    }
    assert.equal(fs.existsSync(contentStateDir), false)

    t.after(async () => {
        await app.close()
        fs.rmSync(sandbox, { recursive: true, force: true })
    })
    return { app, cdnRoot, contentStateDir, observer, outsideRoot, zipBytes }
}

test("parseHttpByteRange supports full, closed, open, suffix, and truncated ranges", () => {
    assert.deepEqual(parseHttpByteRange(undefined, 20), { kind: "full" })
    assert.deepEqual(parseHttpByteRange("bytes=0-9", 20), { kind: "partial", start: 0, end: 9 })
    assert.deepEqual(parseHttpByteRange("bytes=10-", 20), { kind: "partial", start: 10, end: 19 })
    assert.deepEqual(parseHttpByteRange("bytes=-10", 20), { kind: "partial", start: 10, end: 19 })
    assert.deepEqual(parseHttpByteRange("bytes=15-99", 20), { kind: "partial", start: 15, end: 19 })
    assert.deepEqual(parseHttpByteRange("bytes=-99", 20), { kind: "partial", start: 0, end: 19 })
})

test("parseHttpByteRange saturates decimal values relative to the file size", () => {
    const aboveSafeInteger = "9007199254740992"
    assert.deepEqual(
        parseHttpByteRange(`bytes=0-${aboveSafeInteger}`, 20),
        { kind: "partial", start: 0, end: 19 },
    )
    assert.deepEqual(
        parseHttpByteRange(`bytes=-${aboveSafeInteger}`, 20),
        { kind: "partial", start: 0, end: 19 },
    )
    assert.deepEqual(
        parseHttpByteRange(`bytes=${aboveSafeInteger}-`, 20),
        { kind: "unsatisfiable" },
    )
    assert.deepEqual(
        parseHttpByteRange(`bytes=0-${"9".repeat(10_000)}`, 20),
        { kind: "unsatisfiable" },
    )
})

test("parseHttpByteRange rejects invalid and unsatisfiable ranges", () => {
    for (const header of [
        "bytes=20-21",
        "bytes=10-9",
        "bytes=-0",
        "bytes=+1-2",
        "bytes=1--2",
        "bytes=-",
        "bytes=",
        "bytes=x-y",
        "items=0-1",
        "bytes=0-1,3-4",
        ["bytes=0-1"],
    ]) {
        assert.deepEqual(parseHttpByteRange(header, 20), { kind: "unsatisfiable" }, String(header))
    }
    assert.deepEqual(parseHttpByteRange("bytes=0-0", 0), { kind: "unsatisfiable" })
})

test("serves complete responses with byte metadata", async t => {
    const { app, observer, zipBytes } = await createFixture(t)

    const response = await app.inject({
        method: "GET",
        url: "/patch/cn/archive-common-full/base.zip",
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["accept-ranges"], "bytes")
    assert.equal(response.headers["content-length"], String(zipBytes.length))
    assert.deepEqual(response.rawPayload, zipBytes)
    await waitForBalancedHandles(observer)
})

test("HEAD validates CDN and patch files without creating or reading streams", async t => {
    const reads = { createReadStreamCalls: 0, bytes: 0 }
    const { app, observer } = await createFixture(t, {
        fileSystemFactory: () => ({
            realpath: filePath => fs.promises.realpath(filePath),
            lstat: filePath => fs.promises.lstat(filePath),
            open: async (...args) => {
                const handle = await fs.promises.open(...args)
                const createReadStream = handle.createReadStream.bind(handle)
                handle.createReadStream = streamOptions => {
                    reads.createReadStreamCalls++
                    const stream = createReadStream(streamOptions)
                    stream.on("data", chunk => { reads.bytes += chunk.length })
                    return stream
                }
                return handle
            },
        }),
    })
    const cases = [
        {
            url: "/patch/cn/archive-common-full/base.zip",
            statusCode: 200,
            contentLength: "10",
        },
        {
            url: "/patch/cn/archive-common-full/base.zip",
            range: "bytes=2-5",
            statusCode: 206,
            contentLength: "4",
            contentRange: "bytes 2-5/10",
        },
        {
            url: "/patch/cn/archive-common-full/base.zip",
            range: "bytes=99-100",
            statusCode: 416,
            contentLength: "0",
            contentRange: "bytes */10",
        },
        {
            url: "/patch/cn/dummy/download/production/upload/ab/patch-hash",
            statusCode: 200,
            contentLength: "7",
        },
        {
            url: "/patch/cn/dummy/download/production/upload/ab/patch-hash",
            range: "bytes=1-3",
            statusCode: 206,
            contentLength: "3",
            contentRange: "bytes 1-3/7",
        },
        {
            url: "/patch/cn/dummy/download/production/upload/ab/patch-hash",
            range: "bytes=99-100",
            statusCode: 416,
            contentLength: "0",
            contentRange: "bytes */7",
        },
    ]

    for (const expected of cases) {
        const openedBefore = observer.opened
        const closedBefore = observer.closed
        const response = await app.inject({
            method: "HEAD",
            url: expected.url,
            headers: expected.range ? { range: expected.range } : undefined,
        })
        assert.equal(response.statusCode, expected.statusCode, expected.range ?? expected.url)
        assert.equal(response.headers["accept-ranges"], "bytes")
        assert.equal(response.headers["content-length"], expected.contentLength)
        assert.equal(response.headers["content-range"], expected.contentRange)
        assert.equal(response.rawPayload.length, 0)
        await waitForBalancedHandles(observer)
        assert.equal(observer.opened, openedBefore + 1)
        assert.equal(observer.closed, closedBefore + 1)
        assert.equal(reads.createReadStreamCalls, 0)
        assert.equal(reads.bytes, 0)
    }
})

test("serves closed, open, suffix, and truncated ranges", async t => {
    const { app, observer } = await createFixture(t)
    const cases = [
        ["bytes=2-5", "2345", "bytes 2-5/10"],
        ["bytes=6-", "6789", "bytes 6-9/10"],
        ["bytes=-4", "6789", "bytes 6-9/10"],
        ["bytes=7-99", "789", "bytes 7-9/10"],
    ]

    for (const [range, body, contentRange] of cases) {
        const response = await app.inject({
            method: "GET",
            url: "/patch/cn/archive-common-full/base.zip",
            headers: { range },
        })
        assert.equal(response.statusCode, 206, range)
        assert.equal(response.headers["accept-ranges"], "bytes", range)
        assert.equal(response.headers["content-range"], contentRange, range)
        assert.equal(response.headers["content-length"], String(Buffer.byteLength(body)), range)
        assert.equal(response.body, body, range)
    }
    await waitForBalancedHandles(observer)
})

test("serves saturated decimal ranges and rejects oversized Range headers", async t => {
    const { app, observer } = await createFixture(t)
    const cases = [
        ["bytes=0-9007199254740992", 206, "0123456789", "bytes 0-9/10"],
        ["bytes=-9007199254740992", 206, "0123456789", "bytes 0-9/10"],
        ["bytes=9007199254740992-", 416, "", "bytes */10"],
        [`bytes=0-${"9".repeat(1024)}`, 416, "", "bytes */10"],
    ]

    for (const [range, statusCode, body, contentRange] of cases) {
        const response = await app.inject({
            method: "GET",
            url: "/patch/cn/archive-common-full/base.zip",
            headers: { range },
        })
        assert.equal(response.statusCode, statusCode, range)
        assert.equal(response.headers["content-range"], contentRange, range)
        assert.equal(response.body, body, range)
    }
    await waitForBalancedHandles(observer)
})

test("returns empty 416 responses for invalid, unsatisfiable, and empty-file ranges", async t => {
    const { app, observer } = await createFixture(t)
    for (const range of [
        "bytes=99-100",
        "bytes=5-2",
        "bytes=-0",
        "bytes=x-y",
        "items=0-1",
        "bytes=0-1,3-4",
    ]) {
        const response = await app.inject({
            method: "GET",
            url: "/patch/cn/archive-common-full/base.zip",
            headers: { range },
        })
        assert.equal(response.statusCode, 416, range)
        assert.equal(response.headers["content-range"], "bytes */10", range)
        assert.equal(response.headers["content-length"], "0", range)
        assert.equal(response.rawPayload.length, 0, range)
    }

    const empty = await app.inject({
        method: "GET",
        url: "/patch/cn/EntityLists/empty.csv",
        headers: { range: "bytes=0-0" },
    })
    assert.equal(empty.statusCode, 416)
    assert.equal(empty.headers["content-range"], "bytes */0")
    assert.equal(empty.headers["content-length"], "0")
    assert.equal(empty.rawPayload.length, 0)
    await waitForBalancedHandles(observer)
})

test("keeps ZIP allowlist, ordinary files, patch upload, and path boundaries", async t => {
    const { app, contentStateDir, observer } = await createFixture(t)

    const ordinary = await app.inject({ method: "GET", url: "/patch/cn/objects/ordinary.bin" })
    assert.equal(ordinary.statusCode, 200)
    assert.equal(ordinary.body, "ordinary")

    const patch = await app.inject({
        method: "GET",
        url: "/patch/cn/dummy/download/production/upload/ab/patch-hash",
    })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.body, "patched")

    for (const url of [
        "/patch/cn/archive-common-full/extra.zip",
        "/patch/cn/archive-common-full/outside.zip",
        "/patch/cn/objects/outside.bin",
        "/patch/cn/%2e%2e/outside.zip",
        "/patch/cn/archive-common-full%2fbase.zip",
        "/patch/cn/archive-common-full%5cbase.zip",
        "/patch/cn/archive-common-full/%62ase.zip",
        "/patch/cn/dummy/download/production/upload/%61b/patch-hash",
    ]) {
        assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url)
    }

    const recovery = await app.inject({ method: "GET", url: "/patch/cn/recovery/empty.csv" })
    assert.equal(recovery.statusCode, 200)
    assert.match(recovery.headers["content-type"], /^text\/csv/)
    assert.equal(recovery.headers["content-length"], "0")
    assert.equal(recovery.rawPayload.length, 0)
    assert.equal(fs.existsSync(contentStateDir), false)
    await waitForBalancedHandles(observer)
})

test("rejects a Catalog ZIP reached through an intermediate directory symlink", async t => {
    const targetBody = "middle-secret"
    const { app, observer } = await createFixture(t, {
        setup: ({ cdnRoot }) => {
            fs.mkdirSync(path.join(cdnRoot, "actual-middle"))
            fs.writeFileSync(path.join(cdnRoot, "actual-middle", "allowed.zip"), targetBody)
            fs.symlinkSync("actual-middle", path.join(cdnRoot, "archive-middle"))
        },
        archives: () => [archive("archive-middle/allowed.zip", Buffer.byteLength(targetBody))],
    })

    const response = await app.inject({ method: "GET", url: "/patch/cn/archive-middle/allowed.zip" })
    assert.equal(response.statusCode, 404)
    assert.equal(response.body.includes(targetBody), false)
    await waitForBalancedHandles(observer)
})

test("rejects a Catalog ZIP path replaced by a symlink after route registration", async t => {
    const targetBody = "extra"
    const { app, cdnRoot, observer } = await createFixture(t)
    const archivePath = path.join(cdnRoot, "archive-common-full", "base.zip")
    fs.unlinkSync(archivePath)
    fs.symlinkSync("extra.zip", archivePath)

    const response = await app.inject({
        method: "GET",
        url: "/patch/cn/archive-common-full/base.zip",
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.body.includes(targetBody), false)
    await waitForBalancedHandles(observer)
})

test("rejects a Catalog ZIP replaced while its opened handle is validated", async t => {
    const replacementBody = "abcdefghij"
    let swapped = false
    const { app, observer } = await createFixture(t, {
        fileSystemFactory: ({ cdnRoot }) => {
            const archivePath = path.join(cdnRoot, "archive-common-full", "base.zip")
            const physicalArchivePath = fs.realpathSync(archivePath)
            return {
                realpath: filePath => fs.promises.realpath(filePath),
                lstat: filePath => fs.promises.lstat(filePath),
                open: async (...args) => {
                    const handle = await fs.promises.open(...args)
                    if (!swapped && path.resolve(args[0]) === physicalArchivePath) {
                        swapped = true
                        fs.renameSync(archivePath, `${archivePath}.opened`)
                        fs.writeFileSync(archivePath, replacementBody)
                    }
                    return handle
                },
            }
        },
    })

    const response = await app.inject({
        method: "GET",
        url: "/patch/cn/archive-common-full/base.zip",
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.body.includes("0123456789"), false)
    assert.equal(response.body.includes(replacementBody), false)
    assert.equal(swapped, true)
    await waitForBalancedHandles(observer)
    assert.ok(observer.opened > 0)
})

test("rejects a non-ZIP intermediate directory swapped during open validation", async t => {
    const targetBody = "outside-secret"
    let swapped = false
    const { app, observer } = await createFixture(t, {
        setup: ({ outsideRoot }) => {
            fs.writeFileSync(path.join(outsideRoot, "ordinary.bin"), targetBody)
        },
        fileSystemFactory: ({ cdnRoot }) => {
            const assetPath = path.join(cdnRoot, "objects", "ordinary.bin")
            return {
                realpath: async filePath => {
                    const resolved = await fs.promises.realpath(filePath)
                    if (!swapped && path.resolve(filePath) === assetPath) {
                        swapped = true
                        fs.renameSync(path.dirname(assetPath), `${path.dirname(assetPath)}.opened`)
                        fs.symlinkSync(path.join(path.dirname(cdnRoot), "outside"), path.dirname(assetPath))
                    }
                    return resolved
                },
                lstat: filePath => fs.promises.lstat(filePath),
                open: (...args) => fs.promises.open(...args),
            }
        },
    })

    const response = await app.inject({ method: "GET", url: "/patch/cn/objects/ordinary.bin" })
    assert.equal(response.statusCode, 404)
    assert.equal(response.body.includes(targetBody), false)
    assert.equal(swapped, true)
    await waitForBalancedHandles(observer)
    assert.ok(observer.opened > 0)
})

test("releases the FileHandle after a real socket client aborts the response", async t => {
    let serverRequest
    let serverReply
    const { app, observer } = await createFixture(t, {
        configureApp: instance => {
            instance.addHook("onRequest", async (request, reply) => {
                if (request.url !== "/patch/cn/objects/large.bin") return
                serverRequest = request.raw
                serverReply = reply.raw
            })
        },
        fileSystemFactory: ({ cdnRoot }) => {
            const physicalLargePath = fs.realpathSync(path.join(cdnRoot, "objects", "large.bin"))
            return {
                realpath: filePath => fs.promises.realpath(filePath),
                lstat: filePath => fs.promises.lstat(filePath),
                open: async (...args) => {
                    const handle = await fs.promises.open(...args)
                    if (path.resolve(args[0]) === physicalLargePath) {
                        const createReadStream = handle.createReadStream.bind(handle)
                        handle.createReadStream = streamOptions => {
                            const stream = createReadStream({ ...streamOptions, highWaterMark: 1024 })
                            stream.once("data", () => stream.pause())
                            return stream
                        }
                    }
                    return handle
                },
            }
        },
    })

    await captureUnhandledErrors(async () => {
        await app.listen({ host: "127.0.0.1", port: 0 })
        const address = app.server.address()
        assert.ok(address && typeof address === "object")
        await new Promise((resolve, reject) => {
            let aborted = false
            let settled = false
            const finish = error => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                if (error) reject(error)
                else resolve()
            }
            const timeout = setTimeout(() => finish(new Error("socket abort timed out")), 5000)
            const request = http.get({
                host: "127.0.0.1",
                port: address.port,
                path: "/patch/cn/objects/large.bin",
            }, response => {
                response.once("data", () => {
                    aborted = true
                    response.destroy()
                    request.destroy()
                })
                response.once("close", () => finish())
                response.once("error", error => {
                    if (!aborted) finish(error)
                })
            })
            request.once("error", error => {
                if (!aborted) finish(error)
            })
        })
        await waitForBalancedHandles(observer)
    })

    assert.ok(observer.opened > 0)
    assert.ok(serverRequest)
    assert.ok(serverReply)
    assert.equal(serverRequest.listeners("aborted").some(listener => listener.name === "destroyStream"), false)
    assert.equal(serverReply.listeners("close").some(listener => listener.name === "onResponseClose"), false)
})

test("closes a real socket when the read stream fails after headers are sent", async t => {
    const injectedError = new Error("injected post-header stream failure")
    let interruptedStream
    let serverReply
    let headersSentAtDestroy = false
    let responseSeen = false
    let connectionClosed = false
    let responseComplete = true
    const { app, observer } = await createFixture(t, {
        configureApp: instance => {
            instance.addHook("onRequest", async (request, reply) => {
                if (request.url === "/patch/cn/objects/large.bin") serverReply = reply.raw
            })
        },
        fileSystemFactory: ({ cdnRoot }) => {
            const physicalLargePath = fs.realpathSync(path.join(cdnRoot, "objects", "large.bin"))
            return {
                realpath: filePath => fs.promises.realpath(filePath),
                lstat: filePath => fs.promises.lstat(filePath),
                open: async (...args) => {
                    const handle = await fs.promises.open(...args)
                    if (path.resolve(args[0]) === physicalLargePath) {
                        const createReadStream = handle.createReadStream.bind(handle)
                        handle.createReadStream = streamOptions => {
                            const stream = createReadStream({ ...streamOptions, highWaterMark: 1024 })
                            interruptedStream = stream
                            stream.once("data", () => {
                                setImmediate(() => {
                                    headersSentAtDestroy = serverReply.headersSent
                                    stream.destroy(injectedError)
                                })
                            })
                            return stream
                        }
                    }
                    return handle
                },
            }
        },
    })

    await captureUnhandledErrors(async () => {
        await app.listen({ host: "127.0.0.1", port: 0 })
        const address = app.server.address()
        assert.ok(address && typeof address === "object")
        await new Promise((resolve, reject) => {
            let settled = false
            const finish = error => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                if (error) reject(error)
                else resolve()
            }
            const timeout = setTimeout(() => finish(new Error("post-header stream failure timed out")), 5000)
            const request = http.get({
                host: "127.0.0.1",
                port: address.port,
                path: "/patch/cn/objects/large.bin",
            }, response => {
                responseSeen = true
                response.once("close", () => {
                    connectionClosed = true
                    responseComplete = response.complete
                    finish()
                })
                response.on("error", () => {})
                response.resume()
            })
            request.once("error", error => {
                if (!responseSeen) finish(error)
            })
        })
        await waitForBalancedHandles(observer)
    })

    assert.equal(headersSentAtDestroy, true)
    assert.equal(responseSeen, true)
    assert.equal(connectionClosed, true)
    assert.equal(responseComplete, false)
    assert.ok(observer.opened > 0)
    assert.ok(interruptedStream)
    assert.equal(interruptedStream.closed, true)
    assert.equal(
        interruptedStream.listeners("close").some(listener => listener.name === "onStreamClose"),
        false,
    )
})

test("releases the FileHandle when the read stream is destroyed with an error", async t => {
    const injectedError = new Error("injected read stream failure")
    let interruptedStream
    const { app, observer } = await createFixture(t, {
        fileSystemFactory: ({ cdnRoot }) => {
            const physicalLargePath = fs.realpathSync(path.join(cdnRoot, "objects", "large.bin"))
            return {
                realpath: filePath => fs.promises.realpath(filePath),
                lstat: filePath => fs.promises.lstat(filePath),
                open: async (...args) => {
                    const handle = await fs.promises.open(...args)
                    if (path.resolve(args[0]) === physicalLargePath) {
                        const createReadStream = handle.createReadStream.bind(handle)
                        handle.createReadStream = streamOptions => {
                            const stream = createReadStream({ ...streamOptions, highWaterMark: 1024 })
                            interruptedStream = stream
                            stream.once("data", () => stream.destroy(injectedError))
                            return stream
                        }
                    }
                    return handle
                },
            }
        },
    })

    await captureUnhandledErrors(async () => {
        await app.inject({ method: "GET", url: "/patch/cn/objects/large.bin" })
            .catch(() => undefined)
        await waitForBalancedHandles(observer)
    })
    assert.ok(observer.opened > 0)
    assert.ok(interruptedStream)
    assert.equal(interruptedStream.closed, true)
    assert.equal(
        interruptedStream.listeners("close").some(listener => listener.name === "onStreamClose"),
        false,
    )
})
