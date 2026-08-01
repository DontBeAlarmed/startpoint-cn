"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createBetterSqlite3Database,
    resolveNativeBinding,
} = require("../src/runtime/native-binding")

test("embedded native binding resolves a canonical regular file", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const binding = path.join(root, "better_sqlite3.node")
    fs.writeFileSync(binding, "fixture")

    assert.equal(resolveNativeBinding({ BETTER_SQLITE3_NATIVE_BINDING: binding }), fs.realpathSync(binding))
})

test("native binding is optional outside embedded configuration", () => {
    assert.equal(resolveNativeBinding({}), undefined)
})

for (const environment of [
    { BETTER_SQLITE3_NATIVE_BINDING: "relative.node" },
    { BETTER_SQLITE3_NATIVE_BINDING: "/missing/better_sqlite3.node" },
]) {
    test(`rejects invalid native binding ${JSON.stringify(environment)}`, () => {
        assert.throws(
            () => resolveNativeBinding(environment),
            error => error?.code === "INVALID_NATIVE_BINDING",
        )
    })
}

test("rejects native binding files with unsupported extensions", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-extension-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const binding = path.join(root, "better_sqlite3.txt")
    fs.writeFileSync(binding, "fixture")

    assert.throws(
        () => resolveNativeBinding({ BETTER_SQLITE3_NATIVE_BINDING: binding }),
        error => error?.code === "INVALID_NATIVE_BINDING",
    )
})

test("database factory passes the resolved native binding to better-sqlite3", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-factory-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const binding = path.join(root, "better_sqlite3.node")
    fs.writeFileSync(binding, "fixture")
    const calls = []
    const fakeConstructor = (databasePath, options) => {
        calls.push({ databasePath, options })
        return { databasePath, options }
    }

    createBetterSqlite3Database(
        fakeConstructor,
        path.join(root, "wdfp_data.db"),
        { BETTER_SQLITE3_NATIVE_BINDING: binding },
    )

    assert.deepEqual(calls, [{
        databasePath: path.join(root, "wdfp_data.db"),
        options: { nativeBinding: fs.realpathSync(binding) },
    }])
})

test("database factory loads APK-style shared libraries as addon objects", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-android-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const binding = path.join(root, "libsp_better_sqlite3.so")
    fs.writeFileSync(binding, "fixture")
    const addon = { Database: class {} }
    const loaded = []
    const calls = []

    createBetterSqlite3Database(
        (databasePath, options) => {
            calls.push({ databasePath, options })
            return { databasePath, options }
        },
        path.join(root, "wdfp_data.db"),
        { BETTER_SQLITE3_NATIVE_BINDING: binding },
        bindingPath => {
            loaded.push(bindingPath)
            return addon
        },
    )

    assert.deepEqual(loaded, [fs.realpathSync(binding)])
    assert.deepEqual(calls, [{
        databasePath: path.join(root, "wdfp_data.db"),
        options: { nativeBinding: addon },
    }])
})

test("default APK-style addon loader reports a path-free configuration error", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-invalid-addon-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const binding = path.join(root, "libsp_better_sqlite3.so")
    fs.writeFileSync(binding, "not a native addon")

    assert.throws(
        () => createBetterSqlite3Database(
            () => ({ open: true }),
            path.join(root, "wdfp_data.db"),
            { BETTER_SQLITE3_NATIVE_BINDING: binding },
        ),
        error => (
            error?.code === "INVALID_NATIVE_BINDING"
            && !error.message.includes(root)
            && error.cause === undefined
        ),
    )
})
