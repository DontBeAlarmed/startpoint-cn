"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    getDirectoryLinkType,
    runChecked,
} = require("./git-object-runtime.cjs")

test("uses junctions for Windows directory links and dir links elsewhere", () => {
    assert.equal(getDirectoryLinkType("win32"), "junction")
    assert.equal(getDirectoryLinkType("darwin"), "dir")
    assert.equal(getDirectoryLinkType("linux"), "dir")
})

for (const command of ["git", "tar"]) {
    test(`reports clearly when required oracle command ${command} is unavailable`, () => {
        const unavailable = Object.assign(new Error(`spawnSync ${command} ENOENT`), {
            code: "ENOENT",
        })
        assert.throws(
            () => runChecked(command, ["--version"], {}, () => ({ error: unavailable })),
            new RegExp(`Required oracle command "${command}" is unavailable`),
        )
    })
}
