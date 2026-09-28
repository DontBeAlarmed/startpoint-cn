"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")

function listProductionSources(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => {
            const absolutePath = path.join(directory, entry.name)
            return entry.isDirectory() ? listProductionSources(absolutePath) : [absolutePath]
        })
        .filter(filePath => filePath.endsWith(".ts")
            && !filePath.endsWith(".d.ts")
            && !/\.(?:test|type-test)\.ts$/.test(filePath))
        .sort()
}

function isRuntimeDependency(statement) {
    if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly
    if (!ts.isImportDeclaration(statement)) return false

    const clause = statement.importClause
    if (clause === undefined) return true
    if (clause.isTypeOnly) return false
    if (clause.name !== undefined
        || clause.namedBindings === undefined
        || ts.isNamespaceImport(clause.namedBindings)) return true
    return clause.namedBindings.elements.some(element => !element.isTypeOnly)
}

function resolveSourceImport(sourceFiles, fromFile, specifier) {
    if (!specifier.startsWith(".")) return null
    const basePath = path.resolve(path.dirname(fromFile), specifier)
    for (const candidate of [`${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (sourceFiles.has(candidate)) return candidate
    }
    return null
}

function buildRuntimeDependencyGraph() {
    const files = listProductionSources(sourceRoot)
    const sourceFiles = new Set(files)
    const graph = new Map(files.map(filePath => [filePath, []]))

    for (const filePath of files) {
        const source = ts.createSourceFile(
            filePath,
            fs.readFileSync(filePath, "utf8"),
            ts.ScriptTarget.Latest,
            true,
        )
        for (const statement of source.statements) {
            if (!isRuntimeDependency(statement)
                || statement.moduleSpecifier === undefined
                || !ts.isStringLiteral(statement.moduleSpecifier)) continue
            const target = resolveSourceImport(
                sourceFiles,
                filePath,
                statement.moduleSpecifier.text,
            )
            if (target !== null) graph.get(filePath).push(target)
        }
        graph.get(filePath).sort()
    }
    return graph
}

function findRuntimeCycle(graph) {
    const visited = new Set()
    const active = new Map()
    const pathStack = []

    function visit(filePath) {
        const activeIndex = active.get(filePath)
        if (activeIndex !== undefined) {
            return [...pathStack.slice(activeIndex), filePath]
        }
        if (visited.has(filePath)) return null

        active.set(filePath, pathStack.length)
        pathStack.push(filePath)
        for (const dependency of graph.get(filePath) ?? []) {
            const cycle = visit(dependency)
            if (cycle !== null) return cycle
        }
        pathStack.pop()
        active.delete(filePath)
        visited.add(filePath)
        return null
    }

    for (const filePath of graph.keys()) {
        const cycle = visit(filePath)
        if (cycle !== null) return cycle
    }
    return null
}

test("production TypeScript modules have no runtime import cycles", () => {
    const cycle = findRuntimeCycle(buildRuntimeDependencyGraph())
    assert.equal(
        cycle,
        null,
        cycle === null ? undefined : `runtime import cycle:\n${cycle
            .map(filePath => path.relative(projectRoot, filePath))
            .join(" -> ")}`,
    )
})

test("runtime dependency guard detects cycles longer than two modules", () => {
    const graph = new Map([
        ["a.ts", ["b.ts"]],
        ["b.ts", ["c.ts"]],
        ["c.ts", ["a.ts"]],
    ])
    assert.deepEqual(findRuntimeCycle(graph), ["a.ts", "b.ts", "c.ts", "a.ts"])
})

const commonResponseRoot = path.join(sourceRoot, "lib", "common-response")

function isUnder(filePath, directory) {
    return filePath === directory || filePath.startsWith(`${directory}${path.sep}`)
}

function listCommonResponseModules(sourceFiles) {
    return [...sourceFiles].filter(filePath => isUnder(filePath, commonResponseRoot))
}

function collectTransitiveRuntimeDependencies(graph, entryFiles) {
    const closure = new Set()
    const stack = [...entryFiles]
    while (stack.length > 0) {
        const filePath = stack.pop()
        if (closure.has(filePath)) continue
        closure.add(filePath)
        for (const dependency of graph.get(filePath) ?? []) {
            if (!closure.has(dependency)) stack.push(dependency)
        }
    }
    return closure
}

// D28 C6-3 forward guard: the common response projector is a pure leaf layer.
// Its full runtime closure may only contain the core itself plus the typed pure
// projection/contract helpers listed below — never the database layer
// (src/data), Content (src/content), routes (src/routes), Fastify, or business
// owner modules. Any new dependency must be added here consciously.
const COMMON_RESPONSE_ALLOWED_RUNTIME_DEPENDENCIES = new Set([
    // overflow disposition wire adapter and its pure planners
    path.join(sourceRoot, "lib", "item-overflow", "common-response.ts"),
    path.join(sourceRoot, "lib", "item-overflow", "disposition.ts"),
    path.join(sourceRoot, "lib", "inventory", "mana-capacity-plan.ts"),
    // pure RewardGrant typed-result collector (no DB; see reward-grant/projection.ts)
    path.join(sourceRoot, "lib", "reward-grant", "projection.ts"),
])

function collectExternalRuntimeDependencies(filePath) {
    const source = ts.createSourceFile(
        filePath,
        fs.readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    )
    const specifiers = []
    for (const statement of source.statements) {
        if (!isRuntimeDependency(statement)
            || statement.moduleSpecifier === undefined
            || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        if (!statement.moduleSpecifier.text.startsWith(".")) {
            specifiers.push(statement.moduleSpecifier.text)
        }
    }
    return specifiers
}

test("common response core keeps a closed pure runtime dependency closure", () => {
    const graph = buildRuntimeDependencyGraph()
    const coreModules = listCommonResponseModules(graph.keys())
    assert.ok(coreModules.length > 0, "src/lib/common-response must exist")

    const closure = collectTransitiveRuntimeDependencies(graph, coreModules)
    const violations = [...closure]
        .filter(filePath => !isUnder(filePath, commonResponseRoot))
        .filter(filePath => !COMMON_RESPONSE_ALLOWED_RUNTIME_DEPENDENCIES.has(filePath))
        .sort()
    assert.deepEqual(
        violations.map(filePath => path.relative(projectRoot, filePath)),
        [],
        "common-response runtime closure must stay within the core plus its typed pure helpers",
    )
})

test("common response runtime closure has no external module imports", () => {
    const graph = buildRuntimeDependencyGraph()
    const coreModules = listCommonResponseModules(graph.keys())
    const closure = collectTransitiveRuntimeDependencies(graph, coreModules)

    const violations = [...closure]
        .flatMap(filePath => collectExternalRuntimeDependencies(filePath)
            .map(specifier => `${path.relative(projectRoot, filePath)} -> ${specifier}`))
        .sort()
    assert.deepEqual(
        violations,
        [],
        "common-response must not import Fastify, database drivers, or any other external runtime module",
    )
})

// D28 C6-3 reverse guard: owner modules must not depend on the protocol
// projector. Enforced at the direct-import level for the D28 common core:
// pre-D28 approved owner→domain-projector edges (character.ts → growth
// response-projector, serialize-player → load-projector) are documented
// boundaries and are not restructured by D28.
const OWNER_RESULT_MODULES = [
    path.join(sourceRoot, "lib", "mission", "settlement.ts"),
    path.join(sourceRoot, "lib", "shop", "result.ts"),
    path.join(sourceRoot, "lib", "item-overflow", "disposition.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-contract.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-plan.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-engine.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-outcome.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-result.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "execution-assets.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "snapshot.ts"),
    path.join(sourceRoot, "lib", "reward-grant", "transaction-executor.ts"),
    path.join(sourceRoot, "lib", "character-growth", "commands", "grant-character-exp.ts"),
    path.join(sourceRoot, "lib", "character-growth", "commands", "grant-character-stack.ts"),
    path.join(sourceRoot, "lib", "character-growth", "commands", "learn-mana-nodes.ts"),
]

test("database layer and owner result modules never import the common response projector", () => {
    const graph = buildRuntimeDependencyGraph()
    const dataRoot = path.join(sourceRoot, "data")

    const violations = []
    for (const [filePath, dependencies] of graph) {
        const isOwnerScope = isUnder(filePath, dataRoot)
            || OWNER_RESULT_MODULES.includes(filePath)
        if (!isOwnerScope) continue
        for (const dependency of dependencies) {
            if (isUnder(dependency, commonResponseRoot)) {
                violations.push(
                    `${path.relative(projectRoot, filePath)} -> ${path.relative(projectRoot, dependency)}`,
                )
            }
        }
    }
    assert.deepEqual(
        violations.sort(),
        [],
        "src/data and typed owner result modules must not import src/lib/common-response",
    )
})
