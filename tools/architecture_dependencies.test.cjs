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

function findDirectRuntimeCycle(graph) {
    for (const [filePath, dependencies] of graph) {
        for (const dependency of dependencies) {
            if (graph.get(dependency)?.includes(filePath)) {
                return [filePath, dependency, filePath]
            }
        }
    }
    return null
}

test("production TypeScript modules do not import each other at runtime", () => {
    const cycle = findDirectRuntimeCycle(buildRuntimeDependencyGraph())
    assert.equal(
        cycle,
        null,
        cycle === null ? undefined : `runtime import cycle:\n${cycle
            .map(filePath => path.relative(projectRoot, filePath))
            .join(" -> ")}`,
    )
})
