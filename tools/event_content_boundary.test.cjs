"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

test("event runtime readers use the typed snapshot boundary", () => {
    for (const relativePath of [
        "src/lib/mission/event-battle-facts.ts",
        "src/lib/mission/event-rule-catalog.ts",
        "src/lib/mission/event-coverage-report.ts",
        "src/lib/mission/requirements/event-audit.ts",
        "src/lib/mission/requirements/provider-event.ts",
    ]) {
        const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        assert.doesNotMatch(source, /assets\/mission_event_(?:battle_rules|quest_map|reward)\.json/)
    }
    const battleSource = fs.readFileSync(
        path.join(projectRoot, "src/lib/mission/event-battle-facts.ts"),
        "utf8",
    )
    assert.match(battleSource, /WeakMap<MissionCatalog/)
    assert.doesNotMatch(battleSource, /let exact(?:Multi|Statistics|HardMulti).*Cache/)
})
