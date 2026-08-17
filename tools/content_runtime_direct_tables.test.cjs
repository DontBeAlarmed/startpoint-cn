"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const projectRoot = path.resolve(__dirname, "..")
const expectedAccess = Object.freeze({
    "src/lib/mission/computer-event.ts": Object.freeze({
        "mission_event_reward.json": "bundledEventRewards",
    }),
    "src/lib/mission/event-entry-facts.ts": Object.freeze({
        "mission_event_reward.json": "bundledEventRewards",
    }),
    "src/lib/pass-card.ts": Object.freeze({
        "pass_card_event.json": "bundledPassCardEvents",
        "pass_card_reward.json": "bundledPassCardRewards",
    }),
    "src/lib/quest/score-reward-selection.ts": Object.freeze({
        "reward_element_map.json": "bundledRewardElementMap",
    }),
    "src/multi/player-context.ts": Object.freeze({
        "cdndata/player_rank.json": "bundledPlayerRankTable",
    }),
    "src/routes/api/exchange.ts": Object.freeze({
        "star_crumb_exchange.json": "bundledStarCrumbExchange",
        "star_crumb_exchange_cost.json": "bundledStarCrumbExchangeCost",
    }),
})

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
