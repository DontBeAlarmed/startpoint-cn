"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

test("long rush event writes declare their column order", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/data/domains/rushEvent.ts"),
        "utf8",
    )
    assert.match(source, /INSERT INTO players_rush_events\s*\(/)
    assert.match(source, /INSERT OR REPLACE INTO players_rush_events_played_parties\s*\(/)
    assert.doesNotMatch(source, /INSERT INTO players_rush_events\s*\n\s*VALUES/)
    assert.doesNotMatch(source, /players_rush_events_played_parties\s*\n\s*VALUES/)
})

test("high-parameter writes use named bindings or dedicated parameter builders", () => {
    const files = [
        "src/data/domains/account.ts",
        "src/data/domains/battle-history.ts",
        "src/data/domains/character.ts",
        "src/data/domains/mail.ts",
        "src/data/domains/mission_battle_facts.ts",
        "src/data/domains/party.ts",
        "src/data/domains/practice-battle-history.ts",
        "src/data/domains/quest.ts",
        "src/data/domains/quest_active.ts",
        "src/data/domains/score-attack-history.ts",
        "src/lib/mission/snapshot.ts",
        "src/lib/party-group-persistence.ts",
    ]
    for (const file of files) {
        const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
        assert.doesNotMatch(source, /VALUES\s*\(\?(?:\s*,\s*\?){9,}/, file)
    }
})
