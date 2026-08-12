"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const CN_SERVER = path.join(__dirname, "..", "src", "cn-server.ts")

function parseCnServer() {
    const source = fs.readFileSync(CN_SERVER, "utf8")
    return ts.createSourceFile(CN_SERVER, source, ts.ScriptTarget.Latest, true)
}

function importedNames(sourceFile, moduleSpecifier) {
    const names = []
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !statement.importClause?.namedBindings
            || !ts.isNamedImports(statement.importClause.namedBindings)) continue
        names.push(...statement.importClause.namedBindings.elements.map(element => element.name.text))
    }
    return names
}

function findCapabilitiesRegistration(sourceFile) {
    let registration = null
    const visit = node => {
        if (registration !== null) return
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === "registerRuntimeCapabilitiesRoute") {
            registration = node
            return
        }
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
    return registration
}

test("cn-server imports the capabilities route and snapshot providers", () => {
    const sourceFile = parseCnServer()
    const capabilitiesImports = importedNames(sourceFile, "./runtime/capabilities")

    assert.equal(capabilitiesImports.includes("registerRuntimeCapabilitiesRoute"), true)
    assert.equal(capabilitiesImports.includes("createRuntimeCapabilitiesSnapshot"), true)
    assert.equal(
        importedNames(sourceFile, "./modes/registry").includes("listLoadedModeIdentities"),
        true,
    )
})

test("cn-server capabilities provider reads only fixed local runtime facts", () => {
    const sourceFile = parseCnServer()
    const registration = findCapabilitiesRegistration(sourceFile)
    assert.ok(registration, "cn-server must register the local capabilities route")
    assert.equal(registration.arguments[0]?.getText(sourceFile), "fastify")

    const provider = registration.arguments[1]
    assert.equal(ts.isArrowFunction(provider), true, "snapshot provider must be a closure")
    assert.equal(
        ts.isCallExpression(provider.body),
        true,
        "snapshot provider must only build and return the snapshot",
    )
    assert.equal(provider.body.expression.getText(sourceFile), "createRuntimeCapabilitiesSnapshot")

    const input = provider.body.arguments[0]
    assert.equal(ts.isObjectLiteralExpression(input), true)
    const facts = new Map(input.properties.map(property => [
        property.name?.getText(sourceFile),
        property.initializer?.getText(sourceFile),
    ]))
    assert.deepEqual([...facts], [
        ["bundle", "bundleMetadata"],
        ["content", "getContentSnapshot()"],
        ["loadedModes", "listLoadedModeIdentities()"],
        ["node", "process.versions.node"],
        ["nodeAbi", "process.versions.modules"],
        ["platform", "process.platform"],
        ["arch", "process.arch"],
    ])
    assert.doesNotMatch(
        provider.getText(sourceFile),
        /DATA_DIR|CDN_DIR|player|database|sync|reload|write/i,
    )
})
