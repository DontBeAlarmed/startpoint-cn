"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

function source(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function rejectionLog(sourceText, marker) {
    const markerIndex = sourceText.indexOf(marker)
    assert.notEqual(markerIndex, -1, `${marker} diagnostic must exist`)
    const start = sourceText.lastIndexOf("console.warn(", markerIndex)
    const end = sourceText.indexOf("\n            )", markerIndex)
    assert.notEqual(start, -1, `${marker} diagnostic must use the bounded warning channel`)
    assert.notEqual(end, -1, `${marker} diagnostic must have a finite expression`)
    return sourceText.slice(start, end)
}

function interpolationExpressions(log) {
    return [...log.matchAll(/\$\{([^}]*)\}/g)].map(match => match[1].trim())
}

test("D14 node rejection diagnostics contain the approved finite fields only", () => {
    const logs = [
        rejectionLog(
            source("src/routes/api/character/mana.ts"),
            "learn_mana_node rejected",
        ),
        rejectionLog(
            source("src/routes/api/character/mana-awake.ts"),
            "awake_mana_node rejected",
        ),
    ]

    for (const log of logs) {
        assert.deepEqual(
            [...log.matchAll(/\b(player|char|board|code|nodes)=/g)].map(match => match[1]),
            ["player", "char", "board", "code", "nodes"],
        )
        assert.deepEqual(interpolationExpressions(log), [
            "session.playerId",
            "characterId",
            "getPlayerCharacterSync(session.playerId, characterId)?.manaBoardIndex ?? \"unknown\"",
            "(error && typeof error === \"object\" && \"code\" in error) ? String(error.code) : \"unknown\"",
            "nodeIds.length",
        ])
    }
})

test("D14 route adapters delegate Growth writes to the unified commands", () => {
    const bond = source("src/routes/api/character/bond.ts")
    const mana = source("src/routes/api/character/mana.ts")
    const awake = source("src/routes/api/character/mana-awake.ts")

    assert.match(bond, /receiveBondToken\(/)
    assert.match(bond, /openManaBoard\(/)
    assert.match(mana, /executeLearnManaNodes\(/)
    assert.match(awake, /executeAwakeManaNodes\(/)

    for (const route of [mana, awake]) {
        assert.doesNotMatch(route, /insertPlayerCharacterManaNodesSync/)
        assert.doesNotMatch(route, /updatePlayerCharacterManaNodeAwakeLevelsBatchSync/)
        assert.doesNotMatch(route, /updatePlayerCharacterBondTokenSync/)
        assert.doesNotMatch(route, /updatePlayerItemSync/)
        assert.doesNotMatch(route, /updatePlayerSync/)
    }
})
