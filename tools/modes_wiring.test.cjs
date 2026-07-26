"use strict"

// Wiring contract for the mode seam's production boot step.
//
// cn-server auto-starts on import (`void runtimeCoordinator.start()`), so a
// test cannot import it to observe the composition it hands the runtime
// coordinator. This asserts the same thing statically instead, over the real
// AST rather than a text match: remove or shadow the production wiring and
// these assertions fail, which is exactly the regression class the ordering
// test alone could not catch.

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const CN_SERVER = path.join(__dirname, "..", "src", "cn-server.ts")
const LIFECYCLE_MODULE = "./modes/cn-lifecycle"
const FACTORY = "createContentLifecycleDependencies"
const COORDINATOR = "createRuntimeCoordinator"
const CONTENT_STEP = "initializeContent"

function parseCnServer() {
    const source = fs.readFileSync(CN_SERVER, "utf8")
    return ts.createSourceFile(CN_SERVER, source, ts.ScriptTarget.Latest, true)
}

function findCoordinatorArgument(sourceFile) {
    let objectLiteral = null
    const visit = node => {
        if (objectLiteral) return
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === COORDINATOR
            && node.arguments.length > 0
            && ts.isObjectLiteralExpression(node.arguments[0])) {
            objectLiteral = node.arguments[0]
            return
        }
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
    return objectLiteral
}

test("cn-server imports the seam's lifecycle factory", () => {
    const sourceFile = parseCnServer()
    const imported = sourceFile.statements.some(statement => (
        ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === LIFECYCLE_MODULE
        && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)
        && statement.importClause.namedBindings.elements.some(
            element => element.name.text === FACTORY,
        )
    ))
    assert.ok(
        imported,
        `cn-server must import ${FACTORY} from ${LIFECYCLE_MODULE}; `
        + "without it the mode seam never loads at boot",
    )
})

test("cn-server spreads the lifecycle factory into the coordinator dependencies", () => {
    const objectLiteral = findCoordinatorArgument(parseCnServer())
    assert.ok(objectLiteral, `no ${COORDINATOR}({ ... }) call found in cn-server`)

    const spreadIndex = objectLiteral.properties.findIndex(property => (
        ts.isSpreadAssignment(property)
        && ts.isCallExpression(property.expression)
        && ts.isIdentifier(
            ts.isPropertyAccessExpression(property.expression.expression)
                ? property.expression.expression.name
                : property.expression.expression,
        )
        && (ts.isPropertyAccessExpression(property.expression.expression)
            ? property.expression.expression.name.text
            : property.expression.expression.text) === FACTORY
    ))
    assert.notEqual(
        spreadIndex,
        -1,
        `${COORDINATOR} dependencies must spread ${FACTORY}(...); `
        + "dropping it silently disables module loading at boot",
    )

    // A later initializeContent property would win over the spread and
    // quietly bypass the seam, so the contract covers shadowing too.
    const shadowIndex = objectLiteral.properties.findIndex((property, index) => (
        index > spreadIndex
        && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
        && property.name
        && ts.isIdentifier(property.name)
        && property.name.text === CONTENT_STEP
    ))
    assert.equal(
        shadowIndex,
        -1,
        `a ${CONTENT_STEP} property after the ${FACTORY} spread would override it `
        + "and skip module loading",
    )
})

test("the wiring assertions fail when the production wiring is removed", () => {
    // Guards the guard: run the same checks against a mutated copy with the
    // spread stripped, and require them to fail. Without this, a contract
    // test that silently stopped matching would look like a pass.
    const original = fs.readFileSync(CN_SERVER, "utf8")
    // Cut the spread out by its real AST span rather than by pattern, so the
    // mutation cannot silently miss and leave this check vacuous.
    const spread = findCoordinatorArgument(parseCnServer()).properties.find(property => (
        ts.isSpreadAssignment(property) && property.getText().includes(FACTORY)
    ))
    assert.ok(spread, "the production spread must exist to be removable")
    const mutated = original.slice(0, spread.getStart()) + original.slice(spread.getEnd() + 1)
    assert.notEqual(mutated, original, "mutation must apply")

    const sourceFile = ts.createSourceFile(
        CN_SERVER, mutated, ts.ScriptTarget.Latest, true,
    )
    const objectLiteral = findCoordinatorArgument(sourceFile)
    assert.ok(objectLiteral, "mutated source still has the coordinator call")
    const stillSpread = objectLiteral.properties.some(property => (
        ts.isSpreadAssignment(property)
        && ts.isCallExpression(property.expression)
        && property.expression.getText().includes(FACTORY)
    ))
    assert.equal(stillSpread, false, "removing the wiring must break the contract check")
})
