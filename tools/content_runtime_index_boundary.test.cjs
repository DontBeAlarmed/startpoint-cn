"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")

// D27 C2-C5 may add only reviewed raw-to-typed adapter builders here.
const strictAccessorImporters = new Set([
    "src/lib/inventory/item-inventory-policy.ts",
])

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filePath = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(filePath) : [filePath]
    }).filter(filePath => filePath.endsWith(".ts"))
}

test("strict raw table access is limited to reviewed typed adapter builders", () => {
    const actual = sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        if (relative === "src/content/runtime/table-access.ts") return []
        const source = fs.readFileSync(filePath, "utf8")
        return source.includes("getStrictRuntimeContentTableSync") ? [relative] : []
    }).sort()
    assert.deepEqual(actual, [...strictAccessorImporters].sort())
})

test("production source cannot import the test-only snapshot fixture", () => {
    const violations = sourceFiles(sourceRoot).filter(filePath => (
        fs.readFileSync(filePath, "utf8").includes("content-snapshot-fixture")
    )).map(filePath => path.relative(projectRoot, filePath).split(path.sep).join("/"))
    assert.deepEqual(violations, [])
})

test("raw Config access stays inside the typed Config adapter", () => {
    const readers = sourceFiles(sourceRoot).flatMap(filePath => {
        const source = fs.readFileSync(filePath, "utf8")
        const readsConfig = /repository\.table(?:<[^>]+>)?\(\s*["']config\.json["']/.test(source)
            || /getRuntimeContentTableSync(?:<[^>]+>)?\(\s*["']config\.json["']/.test(source)
        return readsConfig
            ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
            : []
    }).sort()
    assert.deepEqual(readers, ["src/lib/config-content.ts"])

    const legacyUsers = sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        return fs.readFileSync(filePath, "utf8").includes("getConfigSync") ? [relative] : []
    })
    assert.deepEqual(legacyUsers, [])
})
