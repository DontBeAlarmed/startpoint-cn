"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")
const inventoryRoot = path.join(sourceRoot, "lib", "inventory")
const planSymbols = ["planItemCap", "planEventTradeExpiry", "planManaCapacity"]
const planModules = ["item-cap-plan", "event-trade-expiry-plan", "mana-capacity-plan"]
const planModuleFiles = new Set(planModules.map(moduleName => (
    path.join(inventoryRoot, `${moduleName}.ts`)
)))

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) return sourceFiles(target)
        return entry.isFile() && entry.name.endsWith(".ts") ? [target] : []
    })
}

test("C1 pure plans are not imported or called by production adapters", () => {
    const violations = []
    for (const file of sourceFiles(sourceRoot)) {
        if (planModuleFiles.has(file)) continue
        const source = fs.readFileSync(file, "utf8")
        if ([...planSymbols, ...planModules].some(token => source.includes(token))) {
            violations.push(path.relative(projectRoot, file))
        }
    }
    assert.deepEqual(violations, [])
})

test("C1 pure plans have no database, route, Mail, Currency or logging dependency", () => {
    for (const moduleName of planModules) {
        const file = path.join(inventoryRoot, `${moduleName}.ts`)
        const source = fs.readFileSync(file, "utf8")
        for (const forbidden of [
            "/data/", "../../data", "/routes/", "../../routes",
            "mail", "currency", "console.", "getContentSnapshot", "getRuntimeContentTableSync",
        ]) {
            assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `${moduleName}: ${forbidden}`)
        }
    }
})
