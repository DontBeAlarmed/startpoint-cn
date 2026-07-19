const assert = require("node:assert/strict")
const test = require("node:test")

const { AGGREGATE_GROUPS, TEST_GROUPS } = require("./groups.cjs")
const { selectTestGroups } = require("./select-tests.cjs")

test("maps representative source files to focused groups", () => {
    assert.deepEqual(selectTestGroups(["src/lib/gacha.ts"]), ["quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/asset.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["admin/src/App.tsx"]), ["admin"])
})

test("upgrades package and unknown source changes to full", () => {
    assert.deepEqual(selectTestGroups(["package.json"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/unmapped/new-feature.ts"]), ["full"])
})

test("deduplicates and stably sorts selected groups", () => {
    assert.deepEqual(
        selectTestGroups([
            "src/lib/gacha.ts",
            "admin/src/App.tsx",
            "src/routes/cn/asset.ts",
            "src/lib/gacha.ts",
        ]),
        ["admin", "integration:cdn", "quick:gacha"],
    )
})

test("full contains quick, integration, and admin but excludes generators", () => {
    assert.deepEqual(
        AGGREGATE_GROUPS.full,
        [...AGGREGATE_GROUPS.quick, ...AGGREGATE_GROUPS.integration, "admin"],
    )
    assert.equal(AGGREGATE_GROUPS.full.includes("generator"), false)
    assert.deepEqual(TEST_GROUPS["integration:cdn"].tests, [])
})

test("keeps compiled-output and external-data tests out of quick", () => {
    assert.deepEqual(TEST_GROUPS["integration:compiled"].tests, [
        "tools/character_awake_refresh.test.cjs",
        "tools/character_stack.test.cjs",
        "tools/equipment_enhancement.test.cjs",
        "tools/event_currency.test.cjs",
        "tools/inventory_rules.test.cjs",
        "tools/mission_completion.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS.generator.tests, [
        "tools/box_gacha_reset.test.cjs",
        "tools/gacha_odds_export.test.cjs",
        "tools/rebuild_gacha_from_odds.test.cjs",
        "tools/score_attack_event.test.cjs",
        "tools/star_grain_material_pack.test.cjs",
        "tools/treasure_key_entry.test.cjs",
    ])
})
