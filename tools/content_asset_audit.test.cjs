const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    ASSET_AUDIT_SOURCE_PAIRS,
    validateAssetAuditSourceRegistry,
} = require("../src/content/audit/source-registry")
const { auditJsonSourcePair } = require("../src/content/audit/json-auditor")
const { auditMissionTableContracts } = require("../src/content/audit/mission-contracts")
const {
    auditRuntimeRegistryTables,
    runContentAssetAudit,
} = require("../src/content/audit/runner")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
const {
    formatContentAssetAuditReport,
    main: runContentAssetAuditCli,
    parseContentAssetAuditArguments,
} = require("../src/content/audit/cli")
const { ContentAssetAuditError } = require("../src/content/audit/types")

function auditFixture(t, sourceValue, runtimeValue) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "content-asset-audit-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sourceRoot = path.join(root, "source")
    const runtimeRoot = path.join(root, "runtime")
    fs.mkdirSync(path.join(sourceRoot, "mission"), { recursive: true })
    fs.mkdirSync(runtimeRoot, { recursive: true })
    if (sourceValue !== undefined) {
        fs.writeFileSync(
            path.join(sourceRoot, "mission/regular_mission.json"),
            typeof sourceValue === "string" ? sourceValue : JSON.stringify(sourceValue),
        )
    }
    if (runtimeValue !== undefined) {
        fs.writeFileSync(
            path.join(runtimeRoot, "mission_regular.json"),
            typeof runtimeValue === "string" ? runtimeValue : JSON.stringify(runtimeValue),
        )
    }
    return {
        sourceRoot,
        runtimeRoot,
        pair: {
            sourceRelativePath: "mission/regular_mission.json",
            runtimeTable: "mission_regular.json",
        },
    }
}

function loadMissionRuntimeTables() {
    const names = [
        "mission_regular.json", "mission_regular_reward.json",
        "mission_daily.json", "mission_daily_reward.json",
        "mission_weekly_def.json", "mission_weekly_reward.json",
        "mission_degree.json", "mission_degree_reward.json",
        "mission_event.json", "mission_event_reward.json",
        "mission_char_awake.json", "mission_char_awake_reward.json",
        "mission_collect_item.json", "mission_collect_item_reward.json",
        "mission_active.json", "mission_active_reward.json",
        "mission_pass_daily.json", "mission_pass_daily_reward.json",
        "mission_pass_week.json", "mission_pass_week_reward.json",
        "mission_pass_event.json", "mission_pass_event_reward.json",
        "pass_card_event.json", "pass_card_reward.json",
    ]
    return Object.fromEntries(names.map(name => [
        name,
        JSON.parse(fs.readFileSync(path.join(__dirname, "../assets", name), "utf8")),
    ]))
}

test("asset audit registers the 25 mission source/runtime pairs", () => {
    assert.equal(ASSET_AUDIT_SOURCE_PAIRS.length, 25)
    assert.equal(
        new Set(ASSET_AUDIT_SOURCE_PAIRS.map(pair => pair.runtimeTable)).size,
        ASSET_AUDIT_SOURCE_PAIRS.length,
    )
    assert.deepEqual(
        ASSET_AUDIT_SOURCE_PAIRS.find(pair => pair.runtimeTable === "mission_char_awake.json"),
        {
            sourceRelativePath: "mission/character_awake_mission.json",
            runtimeTable: "mission_char_awake.json",
        },
    )
    assert.deepEqual(
        ASSET_AUDIT_SOURCE_PAIRS.find(pair => pair.runtimeTable === "mission_pass_event_reward.json"),
        {
            sourceRelativePath: "pass_card/pass_card_event_mission_reward.json",
            runtimeTable: "mission_pass_event_reward.json",
        },
    )
})

test("asset audit source registry rejects duplicate runtime tables", () => {
    assert.throws(
        () => validateAssetAuditSourceRegistry([
            { sourceRelativePath: "mission/regular_mission.json", runtimeTable: "mission_regular.json" },
            { sourceRelativePath: "mission/daily_mission.json", runtimeTable: "mission_regular.json" },
        ]),
        error => error?.code === "CONTENT_ASSET_AUDIT_REGISTRY_DUPLICATE",
    )
})

test("asset audit source registry rejects paths outside owned roots", () => {
    for (const invalid of [
        { sourceRelativePath: "../secret.json", runtimeTable: "mission_regular.json" },
        { sourceRelativePath: "/tmp/secret.json", runtimeTable: "mission_regular.json" },
        { sourceRelativePath: "mission/regular_mission.json", runtimeTable: "../mission_regular.json" },
        { sourceRelativePath: "mission\\regular_mission.json", runtimeTable: "mission_regular.json" },
    ]) {
        assert.throws(
            () => validateAssetAuditSourceRegistry([invalid]),
            error => error?.code === "CONTENT_ASSET_AUDIT_REGISTRY_PATH",
        )
    }
})

test("asset audit compares parsed JSON instead of formatting", t => {
    const fixture = auditFixture(
        t,
        "{\n  \"2\": [[\"b\"]],\n  \"1\": [[\"a\"]]\n}\n",
        "{\"1\":[[\"a\"]],\"2\":[[\"b\"]]}",
    )
    assert.deepEqual(auditJsonSourcePair(fixture), {
        runtimeTable: "mission_regular.json",
        keyCount: 2,
    })
})

test("asset audit reports missing and invalid JSON sources without paths", t => {
    const missingSource = auditFixture(t, undefined, {})
    assert.throws(
        () => auditJsonSourcePair(missingSource),
        error => error?.code === "CONTENT_ASSET_AUDIT_SOURCE_MISSING"
            && !error.message.includes(missingSource.sourceRoot),
    )

    const missingRuntime = auditFixture(t, {}, undefined)
    assert.throws(
        () => auditJsonSourcePair(missingRuntime),
        error => error?.code === "CONTENT_ASSET_AUDIT_RUNTIME_MISSING"
            && !error.message.includes(missingRuntime.runtimeRoot),
    )

    const invalid = auditFixture(t, "{broken", {})
    assert.throws(
        () => auditJsonSourcePair(invalid),
        error => error?.code === "CONTENT_ASSET_AUDIT_JSON_INVALID"
            && error?.inputSide === "source",
    )
})

test("asset audit separates missing files from unreadable input kinds", t => {
    const fixture = auditFixture(t, undefined, {})
    const sourcePath = path.join(fixture.sourceRoot, fixture.pair.sourceRelativePath)
    fs.mkdirSync(sourcePath)
    assert.throws(
        () => auditJsonSourcePair(fixture),
        error => error?.code === "CONTENT_ASSET_AUDIT_SOURCE_UNREADABLE"
            && error?.inputSide === "source",
    )
})

test("asset audit separates key-set drift from nested content drift", t => {
    const keyMismatch = auditFixture(t, { 1: [["a"]], 2: [["b"]] }, { 1: [["a"]] })
    assert.throws(
        () => auditJsonSourcePair(keyMismatch),
        error => error?.code === "CONTENT_ASSET_AUDIT_KEY_MISMATCH"
            && error?.tableName === "mission_regular.json",
    )

    const contentMismatch = auditFixture(t, { 1: [["a"], ["b"]] }, { 1: [["b"], ["a"]] })
    assert.throws(
        () => auditJsonSourcePair(contentMismatch),
        error => error?.code === "CONTENT_ASSET_AUDIT_CONTENT_MISMATCH"
            && error?.tableName === "mission_regular.json",
    )
})

test("mission asset contracts close all official 1.4.54 task and reward references", () => {
    assert.deepEqual(auditMissionTableContracts(loadMissionRuntimeTables()), {
        missionRewardPairCount: 11,
        awakeCharacterCount: 36,
        passCardEventCount: 19,
        passCardRewardCount: 1140,
    })
})

test("mission asset contracts reject missing and empty reward entries", () => {
    const missing = loadMissionRuntimeTables()
    delete missing["mission_daily_reward.json"][Object.keys(missing["mission_daily_reward.json"])[0]]
    assert.throws(
        () => auditMissionTableContracts(missing),
        error => error?.code === "CONTENT_ASSET_AUDIT_MISSION_CONTRACT"
            && error?.tableName === "mission_daily_reward.json",
    )

    const empty = loadMissionRuntimeTables()
    const rewardId = Object.keys(empty["mission_active_reward.json"])[0]
    empty["mission_active_reward.json"][rewardId] = {}
    assert.throws(
        () => auditMissionTableContracts(empty),
        error => error?.code === "CONTENT_ASSET_AUDIT_MISSION_CONTRACT"
            && error?.tableName === "mission_active_reward.json",
    )
})

test("mission asset contracts reject broken awake groups and pass event references", () => {
    const awake = loadMissionRuntimeTables()
    awake["mission_char_awake.json"]["14"][0][19] = "11,12,99"
    assert.throws(
        () => auditMissionTableContracts(awake),
        error => error?.code === "CONTENT_ASSET_AUDIT_MISSION_CONTRACT"
            && error?.tableName === "mission_char_awake.json",
    )

    const pass = loadMissionRuntimeTables()
    pass["pass_card_reward.json"]["1"][0][0] = "999"
    assert.throws(
        () => auditMissionTableContracts(pass),
        error => error?.code === "CONTENT_ASSET_AUDIT_MISSION_CONTRACT"
            && error?.tableName === "pass_card_reward.json",
    )
})

test("asset audit verifies all Content Registry runtime tables", () => {
    const result = auditRuntimeRegistryTables(path.join(__dirname, "../assets"))
    assert.deepEqual(result, { registryTableCount: 125, readableRuntimeTableCount: 125 })
})

test("Content Registry keeps CDN, bundled, and server table boundaries explicit", () => {
    const tablesByScope = new Map()
    for (const definition of TABLE_SOURCES) {
        const tables = tablesByScope.get(definition.scope) ?? []
        tables.push(definition.tableName)
        tablesByScope.set(definition.scope, tables)
    }

    assert.deepEqual(
        Object.fromEntries([...tablesByScope].map(([scope, tables]) => [scope, tables.length])),
        { bundled: 5, cdn: 116, server: 4 },
    )
    assert.deepEqual(tablesByScope.get("bundled"), [
        "cdndata/player_rank_full.json",
        "encyclopedia.json",
        "mission_event_battle_rules.json",
        "mission_event_quest_map.json",
        "practice_quest.json",
    ])
    assert.deepEqual(tablesByScope.get("server"), [
        "cdn_general_shop_whitelist.json",
        "config.json",
        "news.json",
        "payment_products.json",
    ])
})

test("asset audit runner produces a stable report without writing sources", t => {
    const fixture = auditFixture(t, { 1: [["a"]] }, { 1: [["a"]] })
    fs.writeFileSync(path.join(path.dirname(fixture.sourceRoot), "VERSION"), "1.4.54\n")
    const beforeSource = fs.readFileSync(
        path.join(fixture.sourceRoot, fixture.pair.sourceRelativePath),
        "utf8",
    )
    const beforeRuntime = fs.readFileSync(
        path.join(fixture.runtimeRoot, fixture.pair.runtimeTable),
        "utf8",
    )
    const report = runContentAssetAudit({
        sourceRoot: fixture.sourceRoot,
        runtimeRoot: fixture.runtimeRoot,
    }, {
        tableNames: [fixture.pair.runtimeTable],
        sourcePairs: [fixture.pair],
        auditMissionContracts: () => ({
            missionRewardPairCount: 11,
            awakeCharacterCount: 36,
            passCardEventCount: 19,
            passCardRewardCount: 1140,
        }),
    })
    assert.deepEqual(report, {
        schemaVersion: 1,
        sourceVersion: "1.4.54",
        registryTableCount: 1,
        readableRuntimeTableCount: 1,
        deepComparedTableCount: 1,
        deepComparedKeyCount: 1,
        missionContracts: {
            missionRewardPairCount: 11,
            awakeCharacterCount: 36,
            passCardEventCount: 19,
            passCardRewardCount: 1140,
        },
    })
    assert.equal(
        fs.readFileSync(path.join(fixture.sourceRoot, fixture.pair.sourceRelativePath), "utf8"),
        beforeSource,
    )
    assert.equal(
        fs.readFileSync(path.join(fixture.runtimeRoot, fixture.pair.runtimeTable), "utf8"),
        beforeRuntime,
    )
})

test("asset audit rejects source versions outside the supported CN baseline", t => {
    const fixture = auditFixture(t, { 1: [["a"]] }, { 1: [["a"]] })
    fs.writeFileSync(path.join(path.dirname(fixture.sourceRoot), "VERSION"), "1.4.55\n")
    assert.throws(
        () => runContentAssetAudit({
            sourceRoot: fixture.sourceRoot,
            runtimeRoot: fixture.runtimeRoot,
        }, {
            tableNames: [fixture.pair.runtimeTable],
            sourcePairs: [fixture.pair],
            auditMissionContracts: () => ({
                missionRewardPairCount: 0,
                awakeCharacterCount: 0,
                passCardEventCount: 0,
                passCardRewardCount: 0,
            }),
        }),
        error => error?.code === "CONTENT_ASSET_AUDIT_SOURCE_VERSION"
            && !error.message.includes(fixture.sourceRoot),
    )
})

test("asset audit CLI accepts one source root and a stable output format", () => {
    assert.deepEqual(parseContentAssetAuditArguments([
        "--source-root", "../../content-source",
    ], "/project"), {
        sourceRoot: path.resolve("/project", "../../content-source"),
        runtimeRoot: path.resolve("/project", "assets"),
        format: "text",
    })
    assert.deepEqual(parseContentAssetAuditArguments([
        "--source-root", "/content/source/orderedmap",
        "--runtime-root", "/bundle/assets",
        "--format", "json",
    ], "/project"), {
        sourceRoot: "/content/source/orderedmap",
        runtimeRoot: "/bundle/assets",
        format: "json",
    })
    for (const argv of [
        [],
        ["--source-root", "/source", "--source-root", "/other"],
        ["--source-root", "/source", "--format", "yaml"],
        ["--unknown", "value"],
    ]) {
        assert.throws(
            () => parseContentAssetAuditArguments(argv, "/project"),
            error => error?.code === "CONTENT_ASSET_AUDIT_ARGUMENTS",
        )
    }
})

test("asset audit report formats text and canonical JSON without absolute paths", () => {
    const report = {
        schemaVersion: 1,
        sourceVersion: "1.4.54",
        registryTableCount: 111,
        readableRuntimeTableCount: 110,
        deepComparedTableCount: 25,
        deepComparedKeyCount: 7441,
        missionContracts: {
            missionRewardPairCount: 11,
            awakeCharacterCount: 36,
            passCardEventCount: 19,
            passCardRewardCount: 1140,
        },
    }
    assert.match(formatContentAssetAuditReport(report, "text"), /25\/25.*110\/111/s)
    assert.deepEqual(JSON.parse(formatContentAssetAuditReport(report, "json")), report)
})

test("asset audit CLI reports safe input side and table diagnostics", () => {
    let stderr = ""
    const status = runContentAssetAuditCli([
        "--source-root", "/content/source",
    ], {
        projectRoot: "/project",
        stdout: { write: () => true },
        stderr: { write: value => { stderr += value; return true } },
        runAudit: () => {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_JSON_INVALID",
                "invalid source JSON",
                "mission_regular.json",
                "source",
            )
        },
    })
    assert.equal(status, 1)
    assert.match(stderr, /CONTENT_ASSET_AUDIT_JSON_INVALID/)
    assert.match(stderr, /side=source/)
    assert.match(stderr, /table=mission_regular\.json/)
    assert.doesNotMatch(stderr, /\/content\/source|\/project/)

    stderr = ""
    runContentAssetAuditCli(["--source-root", "/content/source"], {
        projectRoot: "/project",
        stdout: { write: () => true },
        stderr: { write: value => { stderr += value; return true } },
        runAudit: () => {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_RUNTIME_UNREADABLE",
                "unreadable runtime JSON",
                "/var/tmp/private-source.json",
                "runtime",
            )
        },
    })
    assert.match(stderr, /side=runtime/)
    assert.doesNotMatch(stderr, /var|tmp|private-source\.json/)
})
