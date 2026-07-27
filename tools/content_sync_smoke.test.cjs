"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { spawnSync } = require("node:child_process")

let smoke
try {
    smoke = require("./content_sync_smoke.cjs")
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

function makeLayout(t) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-smoke-test-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const projectRoot = path.join(sandbox, "project")
    const cdnRoot = path.join(sandbox, "cdn")
    const contentRoot = path.join(sandbox, "content")
    fs.mkdirSync(path.join(projectRoot, ".database"), { recursive: true })
    fs.mkdirSync(path.join(cdnRoot, "cn"), { recursive: true })
    fs.mkdirSync(contentRoot, { mode: 0o700 })
    fs.chmodSync(contentRoot, 0o700)
    return { sandbox, projectRoot, cdnRoot, contentRoot }
}

function runGit(projectRoot, args) {
    const result = spawnSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Smoke Fixture",
            GIT_AUTHOR_EMAIL: "smoke@example.invalid",
            GIT_COMMITTER_NAME: "Smoke Fixture",
            GIT_COMMITTER_EMAIL: "smoke@example.invalid",
        },
    })
    assert.equal(result.status, 0, result.stderr)
}

function makeSourceLayout(t) {
    const fixture = makeLayout(t)
    fs.mkdirSync(path.join(fixture.projectRoot, "assets"), { recursive: true })
    fs.mkdirSync(path.join(fixture.cdnRoot, "cn", "archive-common-full"), { recursive: true })
    fs.mkdirSync(path.join(fixture.cdnRoot, "cn", "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(fixture.projectRoot, "tracked.txt"), "tracked\n")
    fs.writeFileSync(path.join(fixture.projectRoot, "assets", "confirmed_seeds.json"), "{}\n")
    fs.writeFileSync(path.join(fixture.projectRoot, ".database", "players.sqlite"), "db-v1")
    fs.writeFileSync(
        path.join(fixture.cdnRoot, "cn", "archive-common-full", "fixture.zip"),
        "zip",
    )
    fs.writeFileSync(
        path.join(fixture.cdnRoot, "cn", "EntityLists", "fixture-android_medium.csv"),
        "path,version,size,digest,layer\n",
    )
    runGit(fixture.projectRoot, ["init", "--quiet"])
    runGit(fixture.projectRoot, ["add", "tracked.txt"])
    runGit(fixture.projectRoot, ["commit", "--quiet", "-m", "fixture"])
    return { ...fixture, paths: smoke.resolveSmokePaths(fixture) }
}

function assertSourceMutation(before, after) {
    assert.throws(
        () => smoke.assertEnvironmentUnchanged(before, after),
        error => error?.code === "CONTENT_SYNC_SMOKE_SOURCE_MUTATED"
            && !error.message.includes("/")
            && !error.message.includes("\\"),
    )
}

function fixtureCanonicalDigest(value) {
    return `sha256:${crypto.createHash("sha256")
        .update(`${JSON.stringify(value)}\n`)
        .digest("hex")}`
}

test("smoke 参数必须显式提供 CDN 父目录与临时 content root", () => {
    assert.equal(typeof smoke?.parseSmokeArguments, "function")
    assert.deepEqual(smoke.parseSmokeArguments([
        "--cdn-root", "/fixture/cdn",
        "--content-root", "/fixture/content",
    ]), {
        cdnRoot: "/fixture/cdn",
        contentRoot: "/fixture/content",
    })

    for (const argv of [
        [],
        ["--cdn-root", "/fixture/cdn"],
        ["--content-root", "/fixture/content"],
        ["--cdn-root", "/fixture/cdn", "--cdn-root", "/again", "--content-root", "/fixture/content"],
        ["--cdn-root", "/fixture/cdn", "--content-root", "/fixture/content", "--force"],
    ]) {
        assert.throws(
            () => smoke.parseSmokeArguments(argv),
            error => error?.code === "CONTENT_SYNC_SMOKE_ARGUMENTS",
        )
    }
})

test("smoke 路径拒绝与 project、database、CDN 的物理重叠", t => {
    const fixture = makeLayout(t)
    const resolved = smoke.resolveSmokePaths(fixture)
    assert.equal(resolved.env.CDN_DIR, fs.realpathSync(fixture.cdnRoot))
    assert.equal(resolved.env.CONTENT_DIR, path.join(fs.realpathSync(fixture.contentRoot), "release"))
    assert.equal(Object.hasOwn(resolved.env, "CONTENT_STORE_DIR"), false)
    assert.equal(Object.hasOwn(resolved.env, "CONTENT_STATE_DIR"), false)
    assert.equal(
        resolved.env.CONTENT_RUNTIME_DIR,
        path.join(fs.realpathSync(fixture.projectRoot), "assets"),
    )

    fs.chmodSync(fixture.projectRoot, 0o700)
    fs.chmodSync(path.join(fixture.projectRoot, ".database"), 0o700)
    fs.chmodSync(fixture.cdnRoot, 0o700)

    for (const [contentRoot, protectedName] of [
        [fixture.projectRoot, "project"],
        [path.join(fixture.projectRoot, ".database"), "database"],
        [fixture.cdnRoot, "CDN"],
    ]) {
        assert.throws(
            () => smoke.resolveSmokePaths({ ...fixture, contentRoot }),
            error => error?.code === "CONTENT_SYNC_SMOKE_PATH_OVERLAP"
                && error.message.includes(protectedName),
        )
    }

    const alias = path.join(fixture.sandbox, "content-alias")
    fs.symlinkSync(fixture.contentRoot, alias)
    assert.throws(
        () => smoke.resolveSmokePaths({ ...fixture, contentRoot: alias }),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )
})

test("content root 只允许不存在或已存在且为空的普通目录", t => {
    const fixture = makeLayout(t)
    fs.writeFileSync(path.join(fixture.contentRoot, "occupied"), "x")
    assert.throws(
        () => smoke.resolveSmokePaths(fixture),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )

    const fileRoot = path.join(fixture.sandbox, "content-file")
    fs.writeFileSync(fileRoot, "x")
    assert.throws(
        () => smoke.resolveSmokePaths({ ...fixture, contentRoot: fileRoot }),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )

    const missingRoot = path.join(fixture.sandbox, "new-content")
    const resolved = smoke.resolveSmokePaths({ ...fixture, contentRoot: missingRoot })
    assert.equal(
        resolved.contentRoot,
        path.join(fs.realpathSync(fixture.sandbox), "new-content"),
    )
    assert.equal(fs.existsSync(missingRoot), false)

    const publicRoot = path.join(fixture.sandbox, "public-content")
    fs.mkdirSync(publicRoot, { mode: 0o755 })
    fs.chmodSync(publicRoot, 0o755)
    assert.throws(
        () => smoke.resolveSmokePaths({ ...fixture, contentRoot: publicRoot }),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )
})

function isolatedWorkflowDependencies(overrides = {}) {
    let runSyncCalls = 0
    return {
        dependencies: {
            captureEnvironment: () => ({
                git: {
                    head: "same",
                    tracked: "same",
                    staged: "same",
                    unstaged: "same",
                    untracked: { digest: "same", count: 0 },
                },
                seeds: { digest: "same", count: 0 },
                database: { digest: "same", count: 0 },
                cdn: {
                    archives: { digest: "same", count: 1 },
                    entityLists: { digest: "same", count: 1 },
                },
            }),
            runSync: async () => {
                runSyncCalls++
                return { status: "synchronized", reason: "forced", targetVersion: "1.4.54" }
            },
            validateSynchronizedContent: async () => ({
                version: "1.4.54",
                tables: 109,
                characters: 505,
                gachas: 584,
                shops: 15762,
            }),
            ...overrides,
        },
        runSyncCalls: () => runSyncCalls,
    }
}

test("content root 被替换为 symlink 时在同步前拒绝", async t => {
    const fixture = makeLayout(t)
    const outside = path.join(fixture.sandbox, "outside")
    fs.mkdirSync(outside, { mode: 0o700 })
    const workflow = isolatedWorkflowDependencies({
        beforePrepareContentRoot(paths) {
            fs.rmdirSync(paths.contentRoot)
            fs.symlinkSync(outside, paths.contentRoot)
        },
    })
    await assert.rejects(
        smoke.runContentSyncSmoke(fixture, workflow.dependencies),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )
    assert.equal(workflow.runSyncCalls(), 0)
})

test("content root 目录 identity 变化时在同步前拒绝", async t => {
    const fixture = makeLayout(t)
    const workflow = isolatedWorkflowDependencies({
        beforePrepareContentRoot(paths) {
            fs.rmdirSync(paths.contentRoot)
            fs.mkdirSync(paths.contentRoot, { mode: 0o700 })
        },
    })
    await assert.rejects(
        smoke.runContentSyncSmoke(fixture, workflow.dependencies),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )
    assert.equal(workflow.runSyncCalls(), 0)
})

test("Release 派生目录逃逸时在同步前拒绝", async t => {
    const fixture = makeLayout(t)
    const outside = path.join(fixture.sandbox, "outside-runtime")
    fs.mkdirSync(outside, { mode: 0o700 })
    const workflow = isolatedWorkflowDependencies({
        beforeRunSync({ paths }) {
            fs.rmdirSync(paths.env.CONTENT_DIR)
            fs.symlinkSync(outside, paths.env.CONTENT_DIR)
        },
    })
    await assert.rejects(
        smoke.runContentSyncSmoke(fixture, workflow.dependencies),
        error => error?.code === "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
    )
    assert.equal(workflow.runSyncCalls(), 0)
})

test("角色基线只接受列明的 skill_count 3 到 6 差异，并保留 skill_count 2", () => {
    const bundled = {
        "1": { name: "", rarity: 5, element: 0, skill_count: 3 },
        "2": { name: "", rarity: 4, element: 1, skill_count: 2 },
        "3": { name: "", rarity: 3, element: 2, skill_count: 1 },
    }
    const release = {
        "1": { name: "", rarity: 5, element: 0, skill_count: 6 },
        "2": { name: "", rarity: 4, element: 1, skill_count: 2 },
        "3": { name: "", rarity: 3, element: 2, skill_count: 1 },
    }

    assert.deepEqual(smoke.validateCharacters({
        bundled,
        release,
        expectedSkillCounts: { "1": 6, "2": 2, "3": 1 },
        expectedCount: 3,
        expectedUpgradeCount: 1,
        expectedTwoSkillCount: 1,
    }), { characters: 3, skillCountUpgrades: 1, twoSkillCharacters: 1 })

    assert.throws(() => smoke.validateCharacters({
        bundled,
        release: { ...release, "3": { ...release["3"], skill_count: 6 } },
        expectedSkillCounts: { "1": 6, "2": 2, "3": 1 },
        expectedCount: 3,
        expectedUpgradeCount: 1,
        expectedTwoSkillCount: 1,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_CHARACTER_BASELINE")
})

test("直接 OrderedMap 表必须逐张等于 bundled 官方基线", () => {
    assert.equal(typeof smoke.validateDirectOrderedMapTables, "function")
    const definitions = [
        { tableName: "direct-a.json", converterId: "ordered-map-json-1" },
        { tableName: "derived.json", converterId: "mission-derived" },
        { tableName: "direct-b.json", converterId: "ordered-map-json-3" },
    ]
    const bundled = {
        "direct-a.json": { 1: [["a"]] },
        "direct-b.json": { 2: { 3: { 4: [["b"]] } } },
    }
    const release = structuredClone(bundled)

    assert.deepEqual(smoke.validateDirectOrderedMapTables({
        definitions,
        readBundled: tableName => bundled[tableName],
        readRelease: tableName => release[tableName],
    }), { tables: 2 })

    release["direct-b.json"][2][3][4][0][0] = "changed"
    assert.throws(() => smoke.validateDirectOrderedMapTables({
        definitions,
        readBundled: tableName => bundled[tableName],
        readRelease: tableName => release[tableName],
    }), error => (
        error?.code === "CONTENT_SYNC_SMOKE_DIRECT_TABLE_BASELINE"
        && error.message.includes("direct-b.json")
    ))
})

test("关卡派生表必须匹配官方摘要且奖励引用闭合", () => {
    function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical)
        if (!value || typeof value !== "object") return value
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    }
    const definitions = [
        { tableName: "main_quest.json", converterId: "quest" },
        { tableName: "practice_quest.json", converterId: "bundled-json" },
    ]
    const release = {
        "main_quest.json": {
            1: { name: "关卡", clearRewardId: 10, rankPointReward: 10, element: 0 },
        },
        "clear_reward.json": { 10: { reward_type: 4, count: 1 } },
        "score_reward.json": {},
    }
    const expectedBaseline = {
        "main_quest.json": {
            entries: 1,
            digest: `sha256:${crypto.createHash("sha256")
                .update(JSON.stringify(canonical(release["main_quest.json"])))
                .digest("hex")}`,
        },
    }
    assert.deepEqual(smoke.validateQuestTables({
        definitions,
        readRelease: tableName => release[tableName],
        expectedBaseline,
    }), { tables: 1 })

    release["main_quest.json"][1].rankPointReward = 11
    assert.throws(() => smoke.validateQuestTables({
        definitions,
        readRelease: tableName => release[tableName],
        expectedBaseline,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_QUEST_BASELINE")
})

test("关卡派生引用必须闭合到练习关卡与每日挑战点", () => {
    const definitions = [
        "daily_challenge_point_lookup.json",
        "event_challenge_point_map.json",
        "quest_lookup.json",
    ].map(tableName => ({ tableName, converterId: "quest" }))
    function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical)
        if (!value || typeof value !== "object") return value
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    }
    function expectedBaseline(release) {
        return Object.fromEntries(definitions.map(({ tableName }) => {
            const table = release[tableName]
            return [tableName, {
                entries: Object.keys(table).length,
                digest: `sha256:${crypto.createHash("sha256")
                    .update(JSON.stringify(canonical(table)))
                    .digest("hex")}`,
            }]
        }))
    }
    const release = {
        "daily_challenge_point_lookup.json": {
            1: { maxPoint: 1, isRecovery: false, name: "挑战次数" },
        },
        "event_challenge_point_map.json": { expert_1: 1 },
        "quest_lookup.json": { "15_91": "" },
        "practice_quest.json": { 91: { name: "" } },
        "clear_reward.json": {},
        "score_reward.json": {},
    }
    assert.deepEqual(smoke.validateQuestTables({
        definitions,
        readRelease: tableName => release[tableName],
        expectedBaseline: expectedBaseline(release),
    }), { tables: 3 })

    const missingPractice = structuredClone(release)
    delete missingPractice["quest_lookup.json"]["15_91"]
    assert.throws(() => smoke.validateQuestTables({
        definitions,
        readRelease: tableName => missingPractice[tableName],
        expectedBaseline: expectedBaseline(missingPractice),
    }), error => error?.code === "CONTENT_SYNC_SMOKE_QUEST_BASELINE")

    const danglingChallengePoint = structuredClone(release)
    danglingChallengePoint["event_challenge_point_map.json"].expert_1 = 251
    assert.throws(() => smoke.validateQuestTables({
        definitions,
        readRelease: tableName => danglingChallengePoint[tableName],
        expectedBaseline: expectedBaseline(danglingChallengePoint),
    }), error => error?.code === "CONTENT_SYNC_SMOKE_QUEST_BASELINE")
})

test("奖励表比较只接受已锁定的 bundled 空 id 与 clear reward 误复制", () => {
    assert.equal(typeof smoke.validateRewardTables, "function")
    const expectedDifferences = {
        clearCorrections: [
            { key: "1", field: "count", value: 123001 },
            { key: "2", field: "id", value: 200 },
        ],
        scoreNullIds: ["10:1"],
        scoreAliases: [
            { group: 10, position: 2, bundledId: 999800, releaseId: 40236 },
        ],
    }
    const bundled = {
        "clear_reward.json": {
            1: { name: "", type: 2, id: 123001, count: 123001 },
            2: { name: "", type: 3, id: 200, count: 200 },
        },
        "score_reward.json": {
            10: [
                { position: 1, type: 0, reward_type: 4, count: 20, field5: 500, id: null },
                { position: 2, type: 0, reward_type: 0, count: 2, field5: 100, id: 999800 },
                { position: 3, type: 0, reward_type: 0, count: 1, field5: 100, id: 999801 },
            ],
        },
        "rare_score_reward.json": { 20: [{ type: 0, id: 42, count: 1 }] },
        "score_attack_border_reward.json": { "1_1": [{ id: 1 }] },
        "rush_event_quest_folder.json": { 1: { 1: [] } },
        "rush_event_ranking_reward.json": { 1: { 1: [] } },
    }
    const release = structuredClone(bundled)
    delete release["clear_reward.json"][1].count
    delete release["clear_reward.json"][2].id
    delete release["score_reward.json"][10][0].id
    release["score_reward.json"][10][1].id = 40236

    assert.deepEqual(smoke.validateRewardTables({
        bundled,
        release,
        itemNames: { 40236: "活动银币", 999800: "活动银币" },
        expectedDifferences,
    }), { tables: 6, clearCorrections: 2, scoreNullIds: 1, scoreAliases: 1 })

    const shiftedAliasRelease = structuredClone(bundled)
    delete shiftedAliasRelease["clear_reward.json"][1].count
    delete shiftedAliasRelease["clear_reward.json"][2].id
    delete shiftedAliasRelease["score_reward.json"][10][0].id
    shiftedAliasRelease["score_reward.json"][10][2].id = 40237
    assert.throws(() => smoke.validateRewardTables({
        bundled,
        release: shiftedAliasRelease,
        itemNames: {
            40236: "活动银币",
            40237: "活动银币",
            999800: "活动银币",
            999801: "活动银币",
        },
        expectedDifferences,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_REWARD_BASELINE")

    release["rare_score_reward.json"][20][0].count = 2
    assert.throws(() => smoke.validateRewardTables({
        bundled,
        release,
        itemNames: { 40236: "活动银币", 999800: "活动银币" },
        expectedDifferences,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_REWARD_BASELINE")
})

test("失败摘要使用稳定错误码、中文状态且不泄露绝对路径", async () => {
    let stdout = ""
    let stderr = ""
    let exitCode = -1
    const projectRoot = path.resolve("/fixture/project")
    const cdnRoot = path.resolve("/fixture/cdn")
    const contentRoot = path.resolve("/fixture/content")
    const code = await smoke.runContentSyncSmokeCli([
        "--cdn-root", cdnRoot,
        "--content-root", contentRoot,
    ], {
        projectRoot,
        runSmoke: async () => {
            throw new smoke.ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_GACHA_BASELINE",
                `卡池不一致：${projectRoot}/assets/gacha.json；${cdnRoot}；${contentRoot}；master/gacha_odds/example.orderedmap`,
            )
        },
        stdout: { write(value) { stdout += value } },
        stderr: { write(value) { stderr += value } },
        setExitCode(value) { exitCode = value },
    })

    assert.equal(code, 1)
    assert.equal(exitCode, 1)
    assert.equal(stdout, "")
    assert.match(stderr, /^BLOCKED \[CONTENT_SYNC_SMOKE_GACHA_BASELINE\]：卡池不一致：<PROJECT_ROOT>/)
    assert.equal(stderr.includes(projectRoot), false)
    assert.equal(stderr.includes(cdnRoot), false)
    assert.equal(stderr.includes(contentRoot), false)
    assert.match(stderr, /master\/gacha_odds\/example\.orderedmap/)
})

test("受控 CLI 错误会清理未知 symlink 目标、引号、空格与换行", async () => {
    let stderr = ""
    const unknownTarget = path.resolve(
        os.tmpdir(),
        "unknown symlink target with spaces",
        "secret.json",
    )
    const code = await smoke.runContentSyncSmokeCli([
        "--cdn-root", path.resolve("/fixture/cdn"),
        "--content-root", path.resolve("/fixture/content"),
    ], {
        projectRoot: path.resolve("/fixture/project"),
        runSmoke: async () => {
            throw new smoke.ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_SOURCE_UNSAFE",
                `未知 symlink："${unknownTarget}"\n伪造下一行`,
            )
        },
        stdout: { write() {} },
        stderr: { write(value) { stderr += value } },
        setExitCode() {},
    })

    assert.equal(code, 1)
    assert.equal(stderr.split("\n").length, 2)
    assert.equal(stderr.includes(unknownTarget), false)
    assert.equal(stderr.includes("伪造下一行"), true)
    assert.match(stderr, /^BLOCKED \[CONTENT_SYNC_SMOKE_SOURCE_UNSAFE\]：未知 symlink："<PATH>" 伪造下一行\n$/)
})

test("未知 CLI Error 不输出原始 message", async () => {
    let stderr = ""
    const secret = `${path.resolve(os.tmpdir(), "private path")}"\nsecret`
    const code = await smoke.runContentSyncSmokeCli([
        "--cdn-root", path.resolve("/fixture/cdn"),
        "--content-root", path.resolve("/fixture/content"),
    ], {
        projectRoot: path.resolve("/fixture/project"),
        runSmoke: async () => { throw new Error(secret) },
        stdout: { write() {} },
        stderr: { write(value) { stderr += value } },
        setExitCode() {},
    })

    assert.equal(code, 1)
    assert.equal(stderr, "BLOCKED [CONTENT_SYNC_SMOKE_FAILED]：内容 smoke 失败\n")
    assert.equal(stderr.includes(secret), false)
})

test("Release、Repository、Catalog 必须同版本并闭合 Registry 表引用", () => {
    const objects = {
        "sha256:catalog": { targetVersion: "1.4.54" },
        "sha256:summary": { counts: { tables: 2 } },
        "sha256:a": { value: "a" },
        "sha256:b": { value: "b" },
    }
    const manifest = {
        assetVersion: "1.4.54",
        catalog: { object: "sha256:catalog" },
        summary: { object: "sha256:summary" },
        tables: {
            "a.json": { object: "sha256:a" },
            "b.json": { object: "sha256:b" },
        },
    }
    const result = smoke.validateReleaseClosure({
        syncResult: { status: "synchronized", reason: "forced", targetVersion: "1.4.54" },
        snapshot: { current: { assetVersion: "1.4.54" }, manifest, objects },
        repositoryInfo: { source: "release", assetVersion: "1.4.54" },
        catalog: objects["sha256:catalog"],
        registryNames: ["a.json", "b.json"],
        expectedVersion: "1.4.54",
        expectedTableCount: 2,
    })
    assert.deepEqual(result, { assetVersion: "1.4.54", tables: 2 })

    assert.throws(() => smoke.validateReleaseClosure({
        syncResult: { status: "synchronized", reason: "forced", targetVersion: "1.4.54" },
        snapshot: { current: { assetVersion: "1.4.54" }, manifest, objects: { ...objects, "sha256:b": undefined } },
        repositoryInfo: { source: "release", assetVersion: "1.4.54" },
        catalog: objects["sha256:catalog"],
        registryNames: ["a.json", "b.json"],
        expectedVersion: "1.4.54",
        expectedTableCount: 2,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_RELEASE_CLOSURE")
})

test("卡池比较忽略费用，但锁定原始行、campaign、类型、ID、数量和 weight", () => {
    const raw = { "1": [["row"]], "2": [["row-2"]] }
    const campaigns = { "1": 10 }
    const baseline = {
        "1": {
            type: 0,
            singleCost: 150,
            pool: { "1": [{ id: 1001, rank: 5, odds: 7 }] },
        },
        "2": {
            type: 1,
            multiCost: 1500,
            pool: { "2": [{ id: 5001, rank: 4, odds: 3 }] },
        },
    }
    const release = structuredClone(baseline)
    release["1"].singleCost = 0
    release["2"].multiCost = 1
    const feature = {
        "1": { "1": [["x", "", "", "", "", "", "", "", ""]] },
    }
    const featureDigest = fixtureCanonicalDigest(feature)

    assert.deepEqual(smoke.validateGachas({
        bundledRaw: raw,
        releaseRaw: structuredClone(raw),
        bundledCampaigns: campaigns,
        releaseCampaigns: structuredClone(campaigns),
        bundledRuntime: baseline,
        releaseRuntime: release,
        releaseFeature: feature,
        expectedGachaCount: 2,
        expectedCampaignCount: 1,
        expectedFeature: {
            outer: 1,
            nonemptyOuter: 1,
            entries: 1,
            rows: 1,
            nonemptyFields: 1,
            noneFields: 0,
        },
        releaseFeatureDigest: featureDigest,
        expectedFeatureDigest: featureDigest,
    }), {
        gachas: 2,
        campaigns: 1,
        featureEntries: 1,
        drawableEntries: 2,
    })

    release["1"].pool["1"][0].odds = 8
    assert.throws(() => smoke.validateGachas({
        bundledRaw: raw,
        releaseRaw: raw,
        bundledCampaigns: campaigns,
        releaseCampaigns: campaigns,
        bundledRuntime: baseline,
        releaseRuntime: release,
        releaseFeature: feature,
        expectedGachaCount: 2,
        expectedCampaignCount: 1,
        expectedFeature: {
            outer: 1,
            nonemptyOuter: 1,
            entries: 1,
            rows: 1,
            nonemptyFields: 1,
            noneFields: 0,
        },
        releaseFeatureDigest: featureDigest,
        expectedFeatureDigest: featureDigest,
    }), error => error?.code === "CONTENT_SYNC_SMOKE_GACHA_BASELINE")
})

test("feature content 同计数但 key 或字段替换时 digest 必须失败", () => {
    const raw = { "1": [["row"]] }
    const baselineRuntime = { "1": { type: 0, pool: {} } }
    const expectedFeature = {
        "1": { "1": [["x", "", "", "", "", "", "", "", ""]] },
    }
    const replacedFeature = {
        "1": { "2": [["y", "", "", "", "", "", "", "", ""]] },
    }
    assert.throws(() => smoke.validateGachas({
        bundledRaw: raw,
        releaseRaw: raw,
        bundledCampaigns: {},
        releaseCampaigns: {},
        bundledRuntime: baselineRuntime,
        releaseRuntime: baselineRuntime,
        releaseFeature: replacedFeature,
        expectedGachaCount: 1,
        expectedCampaignCount: 0,
        expectedFeature: {
            outer: 1,
            nonemptyOuter: 1,
            entries: 1,
            rows: 1,
            nonemptyFields: 1,
            noneFields: 0,
        },
        releaseFeatureDigest: fixtureCanonicalDigest(replacedFeature),
        expectedFeatureDigest: fixtureCanonicalDigest(expectedFeature),
    }), error => error?.code === "CONTENT_SYNC_SMOKE_GACHA_BASELINE")
})

test("商店比较锁定 ID/category/event 边界，Treasure 只比较 ID", () => {
    const item = (marker = 1) => ({ costs: [], rewards: [], marker })
    const bundled = {
        "general_shop.json": { "1": item() },
        "event_item_shop.json": { "11": { "700001": { "2": item() } } },
        "event_item_shop_id_map.json": { "2": { eventType: 11, eventId: 700001 } },
        "boss_coin_shop.json": { "5": { "3": item() }, "8": {} },
        "boss_coin_shop_item_category_map.json": { "3": 5 },
        "star_grain_shop.json": { "4": item() },
        "treasure_shop.json": { "5": item(1) },
        "equipment_enhancement_shop.json": { "6": { ...item(), shopCategoryId: 9 } },
    }
    const release = structuredClone(bundled)
    release["treasure_shop.json"]["5"] = item(999)

    assert.deepEqual(smoke.validateShops({ bundled, release, rushEventIds: [700011, 700012] }), {
        general: 1,
        event: 1,
        boss: 1,
        starGrain: 1,
        treasure: 1,
        equipment: 1,
    })

    release["event_item_shop.json"]["11"]["700011"] = { "99": item() }
    assert.throws(
        () => smoke.validateShops({ bundled, release, rushEventIds: [700011, 700012] }),
        error => error?.code === "CONTENT_SYNC_SMOKE_SHOP_BASELINE",
    )
})

test("商店可用 tracked 官方 raw 基线锁定 Boss，并精确列出 Star Grain 官方额外 ID", () => {
    const item = () => ({ costs: [], rewards: [] })
    const bundled = {
        "general_shop.json": { "1": item() },
        "event_item_shop.json": { "11": { "700001": { "2": item() } } },
        "event_item_shop_id_map.json": { "2": { eventType: 11, eventId: 700001 } },
        "boss_coin_shop.json": { "5": { "3": item() } },
        "boss_coin_shop_item_category_map.json": { "3": 5 },
        "star_grain_shop.json": { "4": item() },
        "treasure_shop.json": { "5": item() },
        "equipment_enhancement_shop.json": { "6": { ...item(), shopCategoryId: 9 } },
    }
    const release = structuredClone(bundled)
    release["boss_coin_shop.json"]["5"]["7"] = item()
    release["boss_coin_shop_item_category_map.json"]["7"] = 5
    release["star_grain_shop.json"]["9999"] = item()

    const stats = smoke.validateShops({
        bundled,
        release,
        rushEventIds: [700011],
        officialBossRows: {
            "3": [["5"]],
            "7": [["5"]],
        },
        officialOnlyStarGrainIds: ["9999"],
        expectedOfficialCounts: {
            bossOfficial: 2,
            bossBundled: 1,
            bossDifference: 1,
            starGrainRelease: 2,
            starGrainBundled: 1,
        },
    })
    assert.equal(stats.boss, 2)
    assert.equal(stats.starGrain, 2)

    assert.throws(() => smoke.validateShops({
        bundled,
        release,
        rushEventIds: [700011],
        officialBossRows: { "3": [["5"]], "7": [["5"]] },
        officialOnlyStarGrainIds: ["9999"],
        expectedOfficialCounts: {
            bossOfficial: 2,
            bossBundled: 1,
            bossDifference: 2,
            starGrainRelease: 2,
            starGrainBundled: 1,
        },
    }), error => error?.code === "CONTENT_SYNC_SMOKE_SHOP_BASELINE")

    release["star_grain_shop.json"]["9998"] = item()
    assert.throws(() => smoke.validateShops({
        bundled,
        release,
        rushEventIds: [700011],
        officialBossRows: { "3": [["5"]], "7": [["5"]] },
        officialOnlyStarGrainIds: ["9999"],
        expectedOfficialCounts: {
            bossOfficial: 2,
            bossBundled: 1,
            bossDifference: 1,
            starGrainRelease: 2,
            starGrainBundled: 1,
        },
    }), error => error?.code === "CONTENT_SYNC_SMOKE_SHOP_BASELINE")
})

test("结构化环境快照变化会阻止通过且摘要不含具体文件路径", () => {
    const before = {
        git: { head: "a", tracked: "b", staged: "c", unstaged: "d", untracked: "e" },
        seeds: { digest: "f", count: 1 },
        database: { digest: "g", count: 1 },
        cdn: {
            archives: { digest: "h", count: 1 },
            entityLists: { digest: "i", count: 1 },
        },
    }
    assert.doesNotThrow(() => smoke.assertEnvironmentUnchanged(before, { ...before }))
    assertSourceMutation(before, {
        ...before,
        cdn: { ...before.cdn, entityLists: { digest: "changed", count: 1 } },
    })
})

test("来源快照检测已 dirty tracked 文件在 smoke 期间继续变化", t => {
    const fixture = makeSourceLayout(t)
    const tracked = path.join(fixture.projectRoot, "tracked.txt")
    fs.writeFileSync(tracked, "dirty-before\n")
    const before = smoke.captureEnvironment(fixture.paths)
    fs.writeFileSync(tracked, "dirty-after\n")
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notEqual(before.git.tracked, after.git.tracked)
    assert.notEqual(before.git.unstaged, after.git.unstaged)
    assertSourceMutation(before, after)
})

test("来源快照分别检测 staged 内容在 smoke 期间变化", t => {
    const fixture = makeSourceLayout(t)
    const tracked = path.join(fixture.projectRoot, "tracked.txt")
    fs.writeFileSync(tracked, "staged-before\n")
    runGit(fixture.projectRoot, ["add", "tracked.txt"])
    const before = smoke.captureEnvironment(fixture.paths)
    fs.writeFileSync(tracked, "staged-after\n")
    runGit(fixture.projectRoot, ["add", "tracked.txt"])
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notEqual(before.git.staged, after.git.staged)
    assertSourceMutation(before, after)
})

test("来源快照检测已有 untracked 文件在 smoke 期间内容变化", t => {
    const fixture = makeSourceLayout(t)
    const untracked = path.join(fixture.projectRoot, "notes.txt")
    fs.writeFileSync(untracked, "before\n")
    const before = smoke.captureEnvironment(fixture.paths)
    fs.writeFileSync(untracked, "after\n")
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(before.git.untracked, after.git.untracked)
    assertSourceMutation(before, after)
})

test("来源文件摘要使用分块读取而非一次性 readFileSync", t => {
    const fixture = makeSourceLayout(t)
    fs.writeFileSync(path.join(fixture.projectRoot, "notes.bin"), Buffer.alloc(256 * 1024, 7))
    const originalReadFileSync = fs.readFileSync
    fs.readFileSync = function guardedReadFileSync(file, ...args) {
        if (typeof file === "number") {
            throw new Error("不得按文件描述符整体读取来源文件")
        }
        return originalReadFileSync.call(this, file, ...args)
    }
    try {
        assert.doesNotThrow(() => smoke.captureEnvironment(fixture.paths))
    } finally {
        fs.readFileSync = originalReadFileSync
    }
})

test("Git 快照超过 64MiB 时返回稳定错误", () => {
    assert.throws(
        () => smoke.runGitSnapshotCommand("/fixture/project", ["diff"], {
            spawn() {
                return { status: null, error: { code: "ENOBUFS" }, stdout: Buffer.alloc(0) }
            },
        }),
        error => error?.code === "CONTENT_SYNC_SMOKE_GIT_TOO_LARGE"
            && !error.message.includes("/fixture/project"),
    )
})

test("Git untracked 嵌套仓库目录项被明确拒绝", t => {
    const fixture = makeSourceLayout(t)
    const nested = path.join(fixture.projectRoot, "vendor-repository")
    fs.mkdirSync(nested)
    runGit(nested, ["init", "--quiet"])
    fs.writeFileSync(path.join(nested, "payload.bin"), "nested")
    assert.throws(
        () => smoke.captureEnvironment(fixture.paths),
        error => error?.code === "CONTENT_SYNC_SMOKE_SOURCE_UNSAFE"
            && !error.message.includes(fixture.sandbox),
    )
})

test("来源快照覆盖 pending seed 的创建与修改", t => {
    const fixture = makeSourceLayout(t)
    const pending = path.join(fixture.projectRoot, "assets", "pending_seeds.json")
    const missing = smoke.captureEnvironment(fixture.paths)
    fs.writeFileSync(pending, "[]\n")
    const created = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(missing.seeds, created.seeds)
    assertSourceMutation(missing, created)

    const before = created
    fs.writeFileSync(pending, "[1]\n")
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(before.seeds, after.seeds)
    assertSourceMutation(before, after)
})

test("来源快照检测 database 文件创建和内容修改", t => {
    const fixture = makeSourceLayout(t)
    const database = path.join(fixture.projectRoot, ".database", "players.sqlite")
    const beforeModify = smoke.captureEnvironment(fixture.paths)
    fs.writeFileSync(database, "db-v2")
    const afterModify = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(beforeModify.database, afterModify.database)
    assertSourceMutation(beforeModify, afterModify)

    const beforeCreate = afterModify
    fs.writeFileSync(path.join(fixture.projectRoot, ".database", "new.sqlite"), "new")
    const afterCreate = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(beforeCreate.database, afterCreate.database)
    assertSourceMutation(beforeCreate, afterCreate)
})

test("来源快照检测 EntityLists 内容变化", t => {
    const fixture = makeSourceLayout(t)
    const entityList = path.join(
        fixture.cdnRoot,
        "cn",
        "EntityLists",
        "fixture-android_medium.csv",
    )
    const before = smoke.captureEnvironment(fixture.paths)
    fs.appendFileSync(entityList, "changed\n")
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(before.cdn.entityLists, after.cdn.entityLists)
    assertSourceMutation(before, after)
})

test("来源快照检测小写 entities 官方布局的内容变化", t => {
    const fixture = makeSourceLayout(t)
    fs.renameSync(
        path.join(fixture.cdnRoot, "cn", "EntityLists"),
        path.join(fixture.cdnRoot, "cn", "entities"),
    )
    const entityList = path.join(
        fixture.cdnRoot,
        "cn",
        "entities",
        "fixture-android_medium.csv",
    )
    const before = smoke.captureEnvironment(fixture.paths)
    fs.appendFileSync(entityList, "changed\n")
    const after = smoke.captureEnvironment(fixture.paths)
    assert.notDeepEqual(before.cdn.entityLists, after.cdn.entityLists)
    assertSourceMutation(before, after)
})

test("archive-* symlink 或非目录不会被静默跳过", async t => {
    await t.test("symlink", () => {
        const fixture = makeSourceLayout(t)
        fs.symlinkSync(
            path.join(fixture.cdnRoot, "cn", "archive-common-full"),
            path.join(fixture.cdnRoot, "cn", "archive-linked"),
        )
        assert.throws(
            () => smoke.captureEnvironment(fixture.paths),
            error => error?.code === "CONTENT_SYNC_SMOKE_CDN_INVALID",
        )
    })
    await t.test("regular file", () => {
        const fixture = makeSourceLayout(t)
        fs.writeFileSync(path.join(fixture.cdnRoot, "cn", "archive-not-directory"), "x")
        assert.throws(
            () => smoke.captureEnvironment(fixture.paths),
            error => error?.code === "CONTENT_SYNC_SMOKE_CDN_INVALID",
        )
    })
})

test("operation 与来源变化同时失败时来源变化为主错误并保留 operation", async t => {
    const fixture = makeLayout(t)
    const operationError = new Error("operation failed")
    let captures = 0
    const workflow = isolatedWorkflowDependencies({
        captureEnvironment() {
            captures++
            return {
                git: {
                    head: "same",
                    tracked: captures === 1 ? "before" : "after",
                    staged: "same",
                    unstaged: "same",
                    untracked: { digest: "same", count: 0 },
                },
                seeds: { digest: "same", count: 0 },
                database: { digest: "same", count: 0 },
                cdn: {
                    archives: { digest: "same", count: 1 },
                    entityLists: { digest: "same", count: 1 },
                },
            }
        },
        async runSync() {
            throw operationError
        },
    })
    await assert.rejects(
        smoke.runContentSyncSmoke(fixture, workflow.dependencies),
        error => error?.code === "CONTENT_SYNC_SMOKE_SOURCE_MUTATED"
            && error.cause === operationError
            && error.diagnostics?.operation?.message === "operation failed"
            && error.diagnostics?.after?.code === "CONTENT_SYNC_SMOKE_SOURCE_MUTATED",
    )
})

test("operation 与 after 快照读取同时失败时保留两侧诊断", async t => {
    const fixture = makeLayout(t)
    const operationError = new Error("operation failed")
    let captures = 0
    const workflow = isolatedWorkflowDependencies({
        captureEnvironment() {
            captures++
            if (captures === 2) {
                throw new smoke.ContentSyncSmokeError(
                    "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE",
                    "无法读取后置来源快照",
                )
            }
            return {
                git: {
                    head: "same",
                    tracked: "same",
                    staged: "same",
                    unstaged: "same",
                    untracked: { digest: "same", count: 0 },
                },
                seeds: { digest: "same", count: 0 },
                database: { digest: "same", count: 0 },
                cdn: {
                    archives: { digest: "same", count: 1 },
                    entityLists: { digest: "same", count: 1 },
                },
            }
        },
        async runSync() {
            throw operationError
        },
    })
    await assert.rejects(
        smoke.runContentSyncSmoke(fixture, workflow.dependencies),
        error => error?.code === "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE"
            && error.cause === operationError
            && error.diagnostics?.operation?.message === "operation failed"
            && error.diagnostics?.after?.message === "无法读取后置来源快照",
    )
})

test("smoke workflow 在隔离目录执行 force sync 并前后核对来源快照", async t => {
    const fixture = makeLayout(t)
    const calls = []
    const summary = await smoke.runContentSyncSmoke(fixture, {
        captureEnvironment(paths) {
            calls.push(["capture", paths.contentRoot])
            return {
                git: { digest: "same" },
                seeds: { digest: "same", count: 1 },
                database: { digest: "same", count: 1 },
                cdn: {
                    archives: { digest: "same", count: 1 },
                    entityLists: { digest: "same", count: 1 },
                },
            }
        },
        async runSync(options) {
            calls.push(["sync", options])
            return { status: "synchronized", reason: "forced", targetVersion: "1.4.54" }
        },
        async validateSynchronizedContent(context) {
            calls.push(["validate", context.syncResult.targetVersion])
            return {
                version: "1.4.54",
                tables: 109,
                characters: 505,
                gachas: 584,
                shops: 15219,
            }
        },
    })

    assert.deepEqual(calls.map(call => call[0]), ["capture", "sync", "validate", "capture"])
    assert.equal(calls[1][1].mode, "force")
    assert.equal(calls[1][1].env.CDN_DIR, fs.realpathSync(fixture.cdnRoot))
    assert.match(summary, /版本 1\.4\.54；Registry 109；角色 505；卡池 584；商店记录 15219/)
    assert.equal(summary.includes(fixture.sandbox), false)
})

test("content sync 文档锁定同 UID 非对抗性 TOCTOU 边界", () => {
    const documentation = fs.readFileSync(
        path.resolve(__dirname, "../docs/cdn/content-sync.md"),
        "utf8",
    )
    assert.match(documentation, /同 UID 开发者手动离线工具/)
    assert.match(documentation, /没有同 UID 进程故意替换 content root、派生目录或祖先路径/)
    assert.match(documentation, /检查时存在或留下可观察变化/)
    assert.match(documentation, /不构成同 UID 对抗性 TOCTOU 防护/)
    assert.doesNotMatch(documentation, /root 被替换.+都会在结果被接受前失败/)
})

test("integration:content 包含离线 smoke fixture，quick 与自动组不运行真实 smoke", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    const quickTests = TEST_GROUPS["quick:content"].tests
    const integrationTests = TEST_GROUPS["integration:content"].tests
    assert.ok(quickTests.includes("tools/character_content.test.cjs"))
    assert.equal(quickTests.includes("tools/content_sync_smoke.test.cjs"), false)
    assert.ok(integrationTests.includes("tools/content_sync_smoke.test.cjs"))
    assert.equal(quickTests.includes("tools/content_sync_smoke.cjs"), false)
    assert.equal(integrationTests.includes("tools/content_sync_smoke.cjs"), false)

    const documentation = fs.readFileSync(
        path.resolve(__dirname, "../docs/cdn/content-sync.md"),
        "utf8",
    )
    assert.match(documentation, /`integration:content` 自动组包含离线 fixture/)
    assert.match(documentation, /真实 CDN smoke 仍必须手动运行/)
})
