const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { AGGREGATE_GROUPS, TEST_GROUPS } = require("./groups.cjs")
const { selectTestGroups } = require("./select-tests.cjs")

test("maps representative source files to focused groups", () => {
    assert.deepEqual(selectTestGroups(["src/lib/gacha.ts"]), ["quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/lib/gacha-draw.ts"]), ["quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/asset.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["admin/src/App.tsx"]), ["admin"])
})

test("selects the registered group before applying workflow path rules", () => {
    assert.deepEqual(
        selectTestGroups(["tools/test-workflow/database-isolation.test.cjs"]),
        ["integration:database"],
    )
})

test("accumulates every directly related source group", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/host-finish-persistence.ts"]),
        ["integration:database", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/awake-unlock.ts"]),
        ["integration:compiled", "integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/web_api/server.ts"]),
        ["admin", "integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/singleBattleQuest.ts"]),
        ["integration:compiled", "integration:database", "quick:quest"],
    )
})

test("upgrades package and unknown source changes to full", () => {
    assert.deepEqual(selectTestGroups(["package.json"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/unmapped/new-feature.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/lib/mission/awake-settlement.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/lib/character.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["tools/test-workflow/groups.cjs"]), ["full"])
})

test("deduplicates and stably sorts selected groups", () => {
    assert.deepEqual(
        selectTestGroups([
            "src/lib/gacha.ts",
            "admin/src/App.tsx",
            "src/lib/quest/host-finish-persistence.ts",
            "src/lib/gacha.ts",
        ]),
        ["admin", "integration:database", "quick:gacha", "quick:quest"],
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

test("registers every test in exactly one leaf group and full covers runtime regressions", () => {
    function findTests(directory) {
        return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) return findTests(entryPath)
            return /\.test\.(?:cjs|js)$/.test(entry.name)
                ? [entryPath.replaceAll(path.sep, "/")]
                : []
        })
    }

    const allTests = [...findTests("tests"), ...findTests("tools")].sort()
    const leafMembership = new Map()
    for (const [group, definition] of Object.entries(TEST_GROUPS)) {
        for (const file of definition.tests) {
            const groups = leafMembership.get(file) ?? []
            groups.push(group)
            leafMembership.set(file, groups)
        }
    }

    assert.ok(allTests.length >= 42)
    for (const file of allTests) {
        assert.deepEqual(leafMembership.get(file), [selectTestGroups([file])[0]], file)
    }

    const generatorTests = new Set(TEST_GROUPS.generator.tests)
    const runtimeTests = allTests.filter(file => !generatorTests.has(file))
    const fullTests = AGGREGATE_GROUPS.full
        .flatMap(group => TEST_GROUPS[group].tests)
        .sort()
    assert.deepEqual(fullTests, runtimeTests)

    const externalDataMarkers = [
        ["wf-assets", "-cn"].join(""),
        ["--git-common", "-dir"].join(""),
        ["direct", "WorkspaceRoot"].join(""),
        ["world", "FlipperRoot"].join(""),
        ["RAW", "_ROOT"].join(""),
    ]
    for (const file of fullTests) {
        const source = fs.readFileSync(file, "utf8")
        for (const marker of externalDataMarkers) {
            assert.equal(source.includes(marker), false, `${file}: ${marker}`)
        }
    }
})

test("keeps quick and safe compiled tests parallel while stateful groups stay serial", () => {
    for (const group of AGGREGATE_GROUPS.quick) {
        assert.equal(TEST_GROUPS[group].execution, "parallel")
    }
    assert.equal(TEST_GROUPS["integration:compiled"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:database"].execution, "serial")
    assert.equal(TEST_GROUPS["integration:cdn"].execution, "serial")
})

test("quick workflow includes the package scripts contract", () => {
    assert.deepEqual(TEST_GROUPS["quick:workflow"].tests, [
        "tools/test-workflow/benchmark.test.cjs",
        "tools/test-workflow/package-scripts.test.cjs",
        "tools/test-workflow/select-tests.test.cjs",
        "tools/test-workflow/run.test.cjs",
        "tools/test-workflow/verify-cn-build.test.cjs",
    ])
})

test("keeps compiled-output and external-data tests out of quick", () => {
    assert.equal(TEST_GROUPS["quick:quest"].tests.includes("tools/quest_abort_route.test.cjs"), false)
    assert.deepEqual(TEST_GROUPS["integration:compiled"].tests, [
        "tools/character_awake_refresh.test.cjs",
        "tools/character_stack.test.cjs",
        "tools/equipment_enhancement.test.cjs",
        "tools/event_currency.test.cjs",
        "tools/inventory_rules.test.cjs",
        "tools/mission_completion.test.cjs",
        "tools/quest_abort_route.test.cjs",
        "tools/score_attack_event.test.cjs",
        "tools/treasure_key_entry.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS.generator.tests, [
        "tools/box_gacha_reset.test.cjs",
        "tools/gacha_odds_export.test.cjs",
        "tools/rebuild_gacha_from_odds.test.cjs",
        "tools/score_attack_event_data.test.cjs",
        "tools/star_grain_material_pack.test.cjs",
        "tools/treasure_key_entry_data.test.cjs",
    ])
})
