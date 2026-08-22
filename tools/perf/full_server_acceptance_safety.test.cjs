"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    assertDistinctOutputPaths,
    atomicWriteFile,
    serializeError,
    snapshotJsonValue,
} = require("./full_server_acceptance_safety.cjs")

function caseVariant(filePath) {
    for (let index = filePath.length - 1; index >= 0; index--) {
        const character = filePath[index]
        if (character >= "a" && character <= "z") {
            return `${filePath.slice(0, index)}${character.toUpperCase()}${filePath.slice(index + 1)}`
        }
        if (character >= "A" && character <= "Z") {
            return `${filePath.slice(0, index)}${character.toLowerCase()}${filePath.slice(index + 1)}`
        }
    }
    return null
}

function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino
}

test("snapshotJsonValue returns detached equivalent plain data", () => {
    const source = {
        nullable: null,
        values: [true, "value", 42, { nested: "field" }],
    }
    const snapshot = snapshotJsonValue(source)

    assert.deepEqual(snapshot, source)
    assert.notEqual(snapshot, source)
    assert.notEqual(snapshot.values, source.values)
    assert.notEqual(snapshot.values[3], source.values[3])
    assert.equal(Object.getPrototypeOf(snapshot), Object.prototype)
    assert.equal(Object.getPrototypeOf(snapshot.values), Array.prototype)
})

test("snapshotJsonValue rejects hostile values without invoking accessors or proxies", () => {
    let touched = false
    const accessor = { nested: {} }
    Object.defineProperty(accessor.nested, "toJSON", {
        enumerable: true,
        get() {
            touched = true
            throw new Error("getter must not run")
        },
    })
    const proxied = { nested: new Proxy({}, {
        get() {
            touched = true
            throw new Error("proxy getter must not run")
        },
        ownKeys() {
            touched = true
            throw new Error("proxy ownKeys must not run")
        },
    }) }
    const cyclic = {}
    cyclic.self = cyclic
    const sparse = [1, 2]
    delete sparse[1]
    const symbol = { [Symbol("hidden")]: true }
    const customObject = Object.create({ inherited: true })
    customObject.value = true
    const customArray = [1]
    Object.setPrototypeOf(customArray, Object.create(Array.prototype))

    for (const value of [
        accessor,
        proxied,
        cyclic,
        sparse,
        symbol,
        customObject,
        customArray,
        { invalid: undefined },
        { invalid: () => {} },
        { invalid: 1n },
        { invalid: Number.POSITIVE_INFINITY },
    ]) {
        assert.throws(() => snapshotJsonValue(value), /unsafe structured value/)
    }
    assert.equal(touched, false)
})

test("snapshotJsonValue rejects over-depth and over-node graphs", () => {
    const deep = {}
    let cursor = deep
    for (let index = 0; index < 40; index++) {
        cursor.next = {}
        cursor = cursor.next
    }
    assert.throws(() => snapshotJsonValue(deep), /unsafe structured value/)
    assert.throws(
        () => snapshotJsonValue(Array.from({ length: 50_001 }, () => true)),
        /unsafe structured value/,
    )
})

test("serializeError handles hostile errors without invoking proxy traps", () => {
    let touched = false
    const hostile = new Proxy({}, {
        get() {
            touched = true
            throw new Error("proxy getter must not run")
        },
        getOwnPropertyDescriptor() {
            touched = true
            throw new Error("proxy descriptor must not run")
        },
    })

    assert.deepEqual(serializeError(hostile), { name: "Error", message: "operation failed" })
    assert.equal(touched, false)
})

test("serializeError redacts credential variants, authorities, hostnames, and platform paths", () => {
    const messages = [
        "login_token=secret",
        "session-token=secret",
        "device_token=device-secret",
        "access_token: access-secret",
        "MULTI_HUB_TOKEN=hub-secret",
        "authToken=auth-secret",
        "loginToken=login-secret",
        "viewer_id=viewer-secret",
        "deviceId=device-secret",
        "room-id=room-secret",
        "raw_frame=frame-secret",
        "rawBody=body-secret",
        "request failed at https://user:secret@example.invalid/private",
        "connect ENOTFOUND private.internal",
        "connect ENOTFOUND db.prod.example.com",
        `connect ENOTFOUND ${os.hostname()}`,
        String.raw`open C:\Users\reviewer\secret.txt`,
        String.raw`open \\private-server\share\secret.txt`,
        "open /home/reviewer/secret.txt",
        "peer 10.0.0.7 failed",
        "peer 2001:db8::7 failed",
        "peer ::1 failed",
        "peer fe80::1%lo0 failed",
    ]
    for (const message of messages) {
        const error = new Error(message)
        error.cause = error
        const serialized = JSON.stringify(serializeError(error))
        assert.doesNotMatch(serialized, /secret|reviewer|private\.internal|private-server|10\.0\.0\.7|2001:db8|login|session|viewer|device|room|raw/i)
        assert.match(serialized, /\[redacted\]/)
        assert.ok(serialized.length < 500, serialized)
    }
})

test("serializeError preserves ordinary diagnostics and bounds cyclic aggregates", () => {
    for (const message of [
        "database close failed",
        "tokenization completed",
        "retry version 1.2.3 completed",
    ]) {
        assert.deepEqual(serializeError(new Error(message)), { name: "Error", message })
    }

    const aggregate = new AggregateError([], "aggregate failed")
    aggregate.cause = aggregate
    aggregate.errors.push(aggregate, ...Array.from({ length: 100 }, () => new Error("leaf failed")))
    const serialized = JSON.stringify(serializeError(aggregate))
    assert.ok(serialized.length < 2_000, serialized.length)
    assert.equal(JSON.parse(serialized).name, "AggregateError")
})

test("assertDistinctOutputPaths rejects symlink aliases", {
    skip: process.platform === "win32" ? "symlink creation requires elevated privileges" : false,
}, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-symlink-alias-"))
    const outputPath = path.join(directory, "full.json")
    const referencePath = path.join(directory, "reference.json")
    fs.writeFileSync(outputPath, "original-output", "utf8")
    fs.symlinkSync("full.json", referencePath)
    try {
        assert.throws(
            () => assertDistinctOutputPaths(outputPath, referencePath, fs),
            /alias|distinct|same|symbolic/i,
        )
        assert.equal(fs.readFileSync(outputPath, "utf8"), "original-output")
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("assertDistinctOutputPaths rejects hard-link aliases independently", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-hardlink-alias-"))
    const outputPath = path.join(directory, "full.json")
    const referencePath = path.join(directory, "reference.json")
    fs.writeFileSync(outputPath, "original-output", "utf8")
    try {
        try {
            fs.linkSync(outputPath, referencePath)
        } catch (error) {
            if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) {
                t.skip(`hard links unavailable: ${error.code}`)
                return
            }
            throw error
        }
        assert.throws(
            () => assertDistinctOutputPaths(outputPath, referencePath, fs),
            /alias|distinct|same/i,
        )
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("assertDistinctOutputPaths rejects missing targets under parent symlink aliases", {
    skip: process.platform === "win32" ? "symlink creation requires elevated privileges" : false,
}, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-parent-alias-"))
    const realParent = path.join(directory, "real")
    const aliasParent = path.join(directory, "alias")
    fs.mkdirSync(realParent)
    fs.symlinkSync("real", aliasParent)
    try {
        assert.throws(() => assertDistinctOutputPaths(
            path.join(realParent, "report.json"),
            path.join(aliasParent, "report.json"),
            fs,
        ), /alias|distinct|same/i)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("atomicWriteFile rejects symlink and directory targets without replacing them", {
    skip: process.platform === "win32" ? "symlink creation requires elevated privileges" : false,
}, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-output-type-"))
    const targetPath = path.join(directory, "target.json")
    const symlinkPath = path.join(directory, "output.json")
    const directoryPath = path.join(directory, "directory.json")
    fs.writeFileSync(targetPath, "original-target", "utf8")
    fs.symlinkSync("target.json", symlinkPath)
    fs.mkdirSync(directoryPath)
    try {
        assert.throws(() => atomicWriteFile(symlinkPath, "new", fs), /symbolic|symlink|regular/i)
        assert.throws(() => atomicWriteFile(directoryPath, "new", fs), /regular|directory/i)
        assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true)
        assert.equal(fs.readFileSync(targetPath, "utf8"), "original-target")
        assert.deepEqual(fs.readdirSync(directoryPath), [])
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("atomicWriteFile preserves existing modes and creates new files with mode 0600", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-output-mode-"))
    try {
        for (const mode of [0o644, 0o660]) {
            const outputPath = path.join(directory, `existing-${mode.toString(8)}.json`)
            fs.writeFileSync(outputPath, "original", { mode })
            fs.chmodSync(outputPath, mode)
            atomicWriteFile(outputPath, "replacement", fs)
            assert.equal(fs.statSync(outputPath).mode & 0o777, mode)
        }
        const newPath = path.join(directory, "new.json")
        atomicWriteFile(newPath, "new", fs)
        assert.equal(fs.statSync(newPath).mode & 0o777, 0o600)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("assertDistinctOutputPaths rejects case-distinct missing targets on a proven insensitive parent", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-case-paths-"))
    try {
        const variant = caseVariant(directory)
        let caseInsensitive = false
        if (variant !== null) {
            try {
                caseInsensitive = sameFileIdentity(fs.statSync(directory), fs.statSync(variant))
            } catch {}
        }
        if (!caseInsensitive) {
            t.skip("current temporary volume is case-sensitive")
            return
        }
        assert.throws(() => assertDistinctOutputPaths(
            path.join(directory, "Report.json"),
            path.join(directory, "report.json"),
            fs,
        ), /alias|distinct|same/i)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("assertDistinctOutputPaths allows case-distinct missing targets on a proven sensitive parent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-sensitive-paths-"))
    const parentRealPath = fs.realpathSync(directory)
    const fileSystem = Object.create(fs)
    fileSystem.statSync = candidate => {
        if (path.resolve(candidate) !== parentRealPath) {
            const error = new Error("case variant does not exist")
            error.code = "ENOENT"
            throw error
        }
        return fs.statSync(candidate)
    }
    try {
        assert.doesNotThrow(() => assertDistinctOutputPaths(
            path.join(directory, "Report.json"),
            path.join(directory, "report.json"),
            fileSystem,
        ))
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("atomicWriteFile preserves targets and clears temporary files when rename fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-atomic-write-"))
    const outputPath = path.join(directory, "full.json")
    fs.writeFileSync(outputPath, "original-output", "utf8")
    const fileSystem = Object.create(fs)
    fileSystem.renameSync = () => { throw new Error("injected rename failure") }
    try {
        assert.throws(
            () => atomicWriteFile(outputPath, "replacement", fileSystem),
            /rename failure/,
        )
        assert.equal(fs.readFileSync(outputPath, "utf8"), "original-output")
        assert.deepEqual(fs.readdirSync(directory), ["full.json"])
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
