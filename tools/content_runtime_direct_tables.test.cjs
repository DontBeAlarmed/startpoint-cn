"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const projectRoot = path.resolve(__dirname, "..")
// All former low-risk facade consumers have migrated to strict typed reads;
// the remaining bundled-fallback readers are tracked by
// content_runtime_authority.test.cjs boundary candidates.
const expectedAccess = Object.freeze({})

function isFunctionLike(node) {
    return ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
        || ts.isConstructorDeclaration(node)
}

function hasAncestor(node, predicate) {
    for (let current = node.parent; current; current = current.parent) {
        if (predicate(current)) return true
    }
    return false
}

function runtimeTableCallFor(node, tableName) {
    return ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "getRuntimeContentTableSync"
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === tableName
}

test("low-risk direct CDN table consumers read whole runtime tables per call", () => {
    for (const [relativePath, tables] of Object.entries(expectedAccess)) {
        const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        const sourceFile = ts.createSourceFile(
            relativePath,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        )

        for (const [tableName, fallbackName] of Object.entries(tables)) {
            const calls = []
            const fallbackReferences = []

            function visit(node) {
                if (runtimeTableCallFor(node, tableName)) calls.push(node)
                if (ts.isIdentifier(node) && node.text === fallbackName) {
                    fallbackReferences.push(node)
                }
                ts.forEachChild(node, visit)
            }
            visit(sourceFile)

            assert.ok(calls.length > 0, `${relativePath} must access ${tableName} through the runtime snapshot`)
            for (const call of calls) {
                assert.ok(
                    hasAncestor(call, isFunctionLike),
                    `${relativePath} must resolve ${tableName} at function/request time`,
                )
                assert.ok(
                    call.arguments[1]
                        && call.arguments[1].getText(sourceFile).includes(fallbackName),
                    `${relativePath} must pass the whole bundled ${tableName} table as initialization fallback`,
                )
            }

            for (const reference of fallbackReferences) {
                const inImport = hasAncestor(reference, ts.isImportDeclaration)
                const inFallbackArgument = calls.some(call => {
                    const fallback = call.arguments[1]
                    return fallback
                        && reference.pos >= fallback.pos
                        && reference.end <= fallback.end
                })
                assert.ok(
                    inImport || inFallbackArgument,
                    `${relativePath} must not read ${tableName} directly or fall back by key`,
                )
            }
        }
    }
})

test("Star Crumb catalog owns its runtime snapshot tables without a bundled bypass", () => {
    const relativePath = "src/lib/star-crumb-exchange/catalog.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
    assert.match(source, /getContentSnapshot\(\)\.repository/)
    for (const tableName of [
        "star_crumb_exchange.json",
        "star_crumb_exchange_cost.json",
    ]) {
        assert.match(source, new RegExp(`repository\\.table[\\s\\S]*?"${tableName.replace(".", "\\.")}"`))
    }
    assert.doesNotMatch(source, /assets\/star_crumb_exchange|getRuntimeContentTableSync/)
})

test("Bond Token catalog owns its runtime snapshot table without a bundled bypass", () => {
    const relativePath = "src/lib/bond-token-exchange/catalog.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
    assert.match(source, /getContentSnapshot\(\)\.repository/)
    assert.match(source, /repository\.table[\s\S]*?"bond_token_exchange\.json"/)
    assert.doesNotMatch(source, /assets\/bond_token_exchange|getRuntimeContentTableSync/)
})
