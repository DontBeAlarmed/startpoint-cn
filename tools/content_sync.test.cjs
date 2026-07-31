"use strict"

const assert = require("node:assert/strict")
const childProcess = require("node:child_process")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { buildCdnCatalog } = require("../src/content/cdn/catalog-builder")
const { hashContentResourcePath } = require("../src/content/resource-path")
const { ContentObjectStore } = require("../src/content/sync/object-store")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
const {
    QUEST_AUXILIARY_SOURCES,
    QUEST_TABLE_SOURCES,
} = require("../src/content/converters/quest")
const {
    hashResourcePath,
    serializeNestedOrderedMap,
    serializeOrderedMap,
} = require("./orderedmap_serializer.cjs")
const {
    ContentSyncLockCleanupError,
    ContentSyncLockError,
    acquireContentSyncLock,
} = require("../src/content/sync/lock")
const {
    ContentSyncCleanupError,
    runContentSync,
} = require("../src/content/sync/engine")
const {
    parseContentSyncArguments,
    runContentSyncCli,
} = require("../src/content/sync/cli")

const projectRoot = path.resolve(__dirname, "..")
const seedCatalogManifestPath = path.join(projectRoot, "assets", "gacha-seed-catalog", "manifest.json")
const seedCatalogManifestDigest = crypto.createHash("sha256")
    .update(fs.readFileSync(seedCatalogManifestPath))
    .digest("hex")
const TEST_TABLE_SOURCES = TABLE_SOURCES.slice(0, 2)

function createSandbox(t, prefix = "content-sync-") {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const paths = {
        layout: "modern",
        cdnDir: path.join(sandbox, ".cdn"),
        cdnRoot: path.join(sandbox, ".cdn", "cn"),
        contentRootDir: path.join(sandbox, ".content"),
        contentStoreDir: path.join(sandbox, ".content-store"),
        contentStateDir: path.join(sandbox, ".content-state"),
        contentRuntimeDir: path.join(sandbox, ".content-runtime"),
    }
    fs.mkdirSync(paths.cdnRoot, { recursive: true })
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return { paths, sandbox }
}

function fakeScan(paths, targetVersion = "1.4.54") {
    return {
        cdnRoot: paths.cdnRoot,
        targetVersion,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
        entityListsFingerprint: {
            physicalPath: path.join(paths.cdnRoot, "EntityLists", `${targetVersion}.csv`),
            compressedBytes: 1,
            mtimeMs: "1",
            ctimeMs: "1",
            dev: "1",
            ino: "1",
        },
        archives: [],
        ignoredPaths: ["ignored.txt"],
    }
}

function fakeCatalog(targetVersion) {
    return {
        targetVersion,
        versions: [targetVersion],
        edges: [],
        installedBytes: 1,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
    }
}

function tableValues(marker = "stable", definitions = TEST_TABLE_SOURCES) {
    return new Map(definitions.map(definition => [
        definition.tableName,
        { marker, tableName: definition.tableName },
    ]))
}

function engineFixture(t, options = {}) {
    const { paths, sandbox } = createSandbox(t)
    const store = new ContentObjectStore(paths)
    const calls = {
        scan: 0,
        materialize: 0,
        catalog: 0,
        index: 0,
        builder: 0,
    }
    let targetVersion = options.targetVersion ?? "1.4.54"
    const tableSources = options.tableSources ?? TEST_TABLE_SOURCES
    let builderValues = options.builderValues ?? tableValues("stable", tableSources)
    const dependencies = {
        resolvePaths: () => paths,
        createStore: () => store,
        scanTarget: async () => {
            calls.scan++
            return fakeScan(paths, targetVersion)
        },
        materializeCatalog: async scan => {
            calls.materialize++
            return { targetVersion: scan.targetVersion }
        },
        buildCatalog: input => {
            calls.catalog++
            return fakeCatalog(input.targetVersion)
        },
        buildArchiveIndex: async () => {
            calls.index++
            return { marker: "index" }
        },
        tableBuilder: {
            build: async () => {
                calls.builder++
                return builderValues
            },
        },
        tableSources,
        ...options.dependencies,
    }
    return {
        calls,
        dependencies,
        paths,
        sandbox,
        store,
        setBuilderValues(value) { builderValues = value },
        setTargetVersion(value) { targetVersion = value },
    }
}

async function sync(fixture, options = {}) {
    return runContentSync({
        projectRoot,
        mode: "normal",
        generatorVersion: 1,
        ...options,
    }, fixture.dependencies)
}

async function readCurrentRelease(store) {
    const current = await store.readCurrent()
    return current === null ? null : store.readRelease(current)
}

function converterOutput(converterId) {
    return Object.fromEntries(TABLE_SOURCES
        .filter(definition => definition.converterId === converterId)
        .map(definition => [definition.tableName, {
            converterId,
            tableName: definition.tableName,
        }]))
}

function gachaRow(overrides = {}) {
    const columns = Array.from({ length: 47 }, () => "")
    columns[11] = " rarity-main "
    columns[13] = "0"
    columns[14] = "z-character"
    columns[15] = "(None)"
    columns[16] = " a-character "
    for (const [column, value] of Object.entries(overrides)) columns[Number(column)] = value
    return columns.join(",")
}

function nestedOrderedMap(id) {
    const inner = serializeOrderedMap([{ key: "1", row: "fixture" }])
    return serializeNestedOrderedMap([{ key: id, row: inner }])
}

function directOrderedMapFixture(depth) {
    let raw = serializeOrderedMap([{ key: "1", row: "fixture" }])
    for (let level = 1; level < depth; level++) {
        raw = serializeNestedOrderedMap([{ key: "1", row: raw }])
    }
    return raw
}

function characterQuestFixture() {
    const columns = Array.from({ length: 99 }, () => "")
    columns[5] = "1"
    return serializeOrderedMap([{ key: "1", row: columns.join(",") }])
}

function inMemoryArchiveIndex(logicalEntries, reads, beforeRead = async () => {}) {
    logicalEntries = new Map(logicalEntries)
    if (!logicalEntries.has("master/campaign/reward_campaign.orderedmap")) {
        logicalEntries.set(
            "master/campaign/reward_campaign.orderedmap",
            serializeOrderedMap([]),
        )
    }
    for (const definition of TABLE_SOURCES) {
        const match = /^ordered-map-json-([1-3])$/.exec(definition.converterId)
        if (!match) continue
        const logicalPath = definition.sourceOrderedMaps[0]
        if (!logicalEntries.has(logicalPath)) {
            logicalEntries.set(
                logicalPath,
                logicalPath === "master/quest/character_quest.orderedmap"
                    ? characterQuestFixture()
                    : directOrderedMapFixture(Number(match[1])),
            )
        }
    }
    const flatRewardSources = new Set([
        "master/reward/clear_reward.orderedmap",
        "master/quest/event/score_attack_border_reward.orderedmap",
    ])
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "reward")) {
        const logicalPath = definition.sourceOrderedMaps[0]
        if (!logicalEntries.has(logicalPath)) {
            logicalEntries.set(
                logicalPath,
                flatRewardSources.has(logicalPath)
                    ? serializeOrderedMap([])
                    : serializeNestedOrderedMap([]),
            )
        }
    }
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "gameplay")) {
        const logicalPath = definition.sourceOrderedMaps[0]
        if (!logicalEntries.has(logicalPath)) {
            logicalEntries.set(logicalPath, serializeOrderedMap([]))
        }
    }
    const boxGachaDepths = new Map([
        ["master/box_gacha/box_gacha.orderedmap", 1],
        ["master/box_gacha/box_reward.orderedmap", 3],
        ["master/box_gacha/box.orderedmap", 2],
    ])
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "box-gacha")) {
        for (const logicalPath of definition.sourceOrderedMaps) {
            if (logicalEntries.has(logicalPath)) continue
            const depth = boxGachaDepths.get(logicalPath)
            assert.ok(depth, `missing box gacha fixture depth: ${logicalPath}`)
            logicalEntries.set(
                logicalPath,
                depth === 1 ? serializeOrderedMap([]) : serializeNestedOrderedMap([]),
            )
        }
    }
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "mana-node")) {
        for (const logicalPath of definition.sourceOrderedMaps) {
            if (!logicalEntries.has(logicalPath)) {
                logicalEntries.set(logicalPath, serializeNestedOrderedMap([]))
            }
        }
    }
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "item-equipment")) {
        for (const logicalPath of definition.sourceOrderedMaps) {
            if (!logicalEntries.has(logicalPath)) {
                logicalEntries.set(logicalPath, serializeOrderedMap([]))
            }
        }
    }
    const questDepths = new Map(Object.values(QUEST_TABLE_SOURCES).map(source => (
        [source.logicalPath, source.nestingDepth]
    )))
    for (const logicalPath of Object.values(QUEST_AUXILIARY_SOURCES)) {
        questDepths.set(logicalPath, 1)
    }
    for (const definition of TABLE_SOURCES.filter(entry => entry.converterId === "quest")) {
        for (const logicalPath of definition.sourceOrderedMaps) {
            if (logicalEntries.has(logicalPath)) continue
            const depth = questDepths.get(logicalPath)
            assert.ok(depth, `missing quest fixture depth: ${logicalPath}`)
            logicalEntries.set(
                logicalPath,
                depth === 1 ? serializeOrderedMap([]) : serializeNestedOrderedMap([]),
            )
        }
    }
    const entries = new Map()
    const logicalByPhysical = new Map()
    for (const [logicalPath, bytes] of logicalEntries) {
        const { relativePath } = hashResourcePath(logicalPath)
        const physicalPath = `production/upload/${relativePath}`
        entries.set(physicalPath, bytes)
        logicalByPhysical.set(physicalPath, logicalPath)
    }
    return {
        has(physicalPath) {
            return entries.has(physicalPath)
        },
        async read(physicalPath) {
            assert.match(physicalPath, /^production\/upload\/[a-f0-9]{2}\/[a-f0-9]{38}$/)
            const logicalPath = logicalByPhysical.get(physicalPath) ?? physicalPath
            reads.push(logicalPath)
            const bytes = entries.get(physicalPath)
            if (!bytes) throw new Error("/private/fixture/archive.zip is missing an entry")
            await beforeRead(logicalPath)
            return Buffer.from(bytes)
        },
    }
}

function defaultBuilderContext(archiveIndex) {
    const scan = fakeScan({ cdnRoot: "/unused-cdn" })
    return {
        projectRoot,
        paths: {
            cdnRoot: "/unused-cdn",
            contentRuntimeDir: "/configured-runtime",
        },
        scan,
        catalog: fakeCatalog(scan.targetVersion),
        archiveIndex,
        definitions: TABLE_SOURCES,
    }
}

test("orderedmap serializer hash stays equivalent to the production resource helper", () => {
    for (const logicalPath of [
        "master/character/character.orderedmap",
        "/master//gacha\\gacha.orderedmap",
        "master/gacha_odds/odds-01.orderedmap",
    ]) {
        assert.deepEqual(hashResourcePath(logicalPath), hashContentResourcePath(logicalPath))
    }
    assert.deepEqual(
        hashResourcePath("master/config/config.orderedmap", "fixture-salt"),
        hashContentResourcePath("master/config/config.orderedmap", "fixture-salt"),
    )
})

test("orderedmap serializer loads as pure CJS without ts-node startup", () => {
    const script = String.raw`
        const Module = require("node:module");
        const originalLoad = Module._load;
        Module._load = function(request, ...args) {
            if (request.startsWith("ts-node")) throw new Error("ts-node must not be loaded");
            return originalLoad.call(this, request, ...args);
        };
        const serializer = require("./tools/orderedmap_serializer.cjs");
        process.stdout.write(JSON.stringify(serializer.hashResourcePath("master/config/config.orderedmap")));
    `
    const startedAt = Date.now()
    const child = childProcess.spawnSync(process.execPath, ["-e", script], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 2_500,
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(
        JSON.parse(child.stdout),
        hashContentResourcePath("master/config/config.orderedmap"),
    )
    assert.ok(elapsedMs < 2_500, `pure CJS require took ${elapsedMs}ms`)
})

test("default release builder closes all registry tables and runs each CDN converter once", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const reads = []
    const logicalEntries = new Map([
        ["master/character/character.orderedmap", serializeOrderedMap([])],
        ["master/character/character_text.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election_exclude.orderedmap", serializeOrderedMap([])],
        ["master/encyclopedia/encyclopedia.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/action_skill.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/switched_action_skill.orderedmap", serializeNestedOrderedMap([])],
        ["master/gacha/gacha.orderedmap", serializeOrderedMap([
            { key: "1", row: gachaRow() },
        ])],
        ["master/gacha_odds/a-character.orderedmap", nestedOrderedMap("a-character")],
        ["master/gacha_odds/rarity-main.orderedmap", nestedOrderedMap("rarity-main")],
        ["master/gacha_odds/z-character.orderedmap", nestedOrderedMap("z-character")],
    ])
    const converterCalls = {
        additionalReward: 0,
        boxGacha: 0,
        character: 0,
        characterElection: 0,
        gacha: 0,
        gameplay: 0,
        itemEquipment: 0,
        manaNode: 0,
        shop: 0,
        skillEffects: 0,
        reward: 0,
        quest: 0,
        rewardCampaign: 0,
    }
    let bundledImports = 0
    const bundledRoots = new Set()
    const builder = createDefaultContentTableBuilder({
        convertAdditionalRewards: async () => {
            converterCalls.additionalReward++
            return converterOutput("additional-reward")
        },
        convertBoxGachaTables: async () => {
            converterCalls.boxGacha++
            return converterOutput("box-gacha")
        },
        convertCharacters: async () => {
            converterCalls.character++
            return converterOutput("character")
        },
        convertCharacterElections: async () => {
            converterCalls.characterElection++
            return converterOutput("character-election")
        },
        convertGachas: async () => {
            converterCalls.gacha++
            return converterOutput("gacha")
        },
        convertGameplayTables: async () => {
            converterCalls.gameplay++
            return converterOutput("gameplay")
        },
        convertItemEquipmentTables: async () => {
            converterCalls.itemEquipment++
            return converterOutput("item-equipment")
        },
        convertManaNodes: async () => {
            converterCalls.manaNode++
            return converterOutput("mana-node")
        },
        convertShops: async () => {
            converterCalls.shop++
            return converterOutput("shop")
        },
        convertSkillEffects: async () => {
            converterCalls.skillEffects++
            return converterOutput("skill-effects")
        },
        convertRewards: async () => {
            converterCalls.reward++
            return converterOutput("reward")
        },
        convertQuests: async () => {
            converterCalls.quest++
            return converterOutput("quest")
        },
        convertRewardCampaigns: async () => {
            converterCalls.rewardCampaign++
            return converterOutput("reward-campaign")
        },
        importBundledTable: async (root, tableName) => {
            bundledRoots.add(root)
            bundledImports++
            return { imported: tableName }
        },
    })

    const built = await builder.build(defaultBuilderContext(
        inMemoryArchiveIndex(logicalEntries, reads),
    ))

    assert.equal(built.size, TABLE_SOURCES.length)
    assert.deepEqual([...built.keys()], TABLE_SOURCES.map(definition => definition.tableName))
    assert.deepEqual(converterCalls, {
        additionalReward: 1,
        boxGacha: 1,
        character: 1,
        characterElection: 1,
        gacha: 1,
        gameplay: 1,
        itemEquipment: 1,
        manaNode: 1,
        shop: 1,
        skillEffects: 1,
        reward: 1,
        quest: 1,
        rewardCampaign: 1,
    })
    assert.equal(
        bundledImports,
        new Set(TABLE_SOURCES.flatMap(definition => [
            ...(definition.converterId === "bundled-json"
                || definition.converterId === "server-json"
                ? [definition.tableName]
                : []),
            ...definition.bundledSources.map(source => source.replace(/^assets\//, "")),
        ])).size,
    )
    assert.deepEqual([...bundledRoots], ["/configured-runtime"])
    assert.deepEqual(reads.filter(logicalPath => (
        logicalPath.startsWith("master/gacha_odds/")
    )), [
        "master/gacha_odds/a-character.orderedmap",
        "master/gacha_odds/rarity-main.orderedmap",
        "master/gacha_odds/z-character.orderedmap",
    ])
})

test("default release builder fails explicitly for a missing dynamic gacha reference", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const reads = []
    const logicalEntries = new Map([
        ["master/character/character.orderedmap", serializeOrderedMap([])],
        ["master/character/character_text.orderedmap", serializeOrderedMap([])],
        ["master/gacha/gacha.orderedmap", serializeOrderedMap([
            { key: "1", row: gachaRow() },
        ])],
        ["master/gacha_odds/a-character.orderedmap", nestedOrderedMap("a-character")],
        ["master/gacha_odds/rarity-main.orderedmap", nestedOrderedMap("rarity-main")],
    ])
    const builder = createDefaultContentTableBuilder({
        convertCharacters: async () => converterOutput("character"),
        convertCharacterElections: async () => converterOutput("character-election"),
        convertGachas: async () => converterOutput("gacha"),
        convertShops: async () => converterOutput("shop"),
        convertSkillEffects: async () => converterOutput("skill-effects"),
        importBundledTable: async (_root, tableName) => ({ imported: tableName }),
    })

    await assert.rejects(
        builder.build(defaultBuilderContext(inMemoryArchiveIndex(logicalEntries, reads))),
        error => (
            /referenced gacha odds.*master\/gacha_odds\/z-character\.orderedmap/i.test(
                error.message,
            )
            && !error.message.includes("/private/fixture")
        ),
    )
    assert.equal(reads.includes("master/gacha_odds/(None).orderedmap"), false)
})

test("default release builder rejects an incomplete converter output", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const logicalEntries = new Map([
        ["master/character/character.orderedmap", serializeOrderedMap([])],
        ["master/character/character_text.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election_exclude.orderedmap", serializeOrderedMap([])],
        ["master/encyclopedia/encyclopedia.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/action_skill.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/switched_action_skill.orderedmap", serializeNestedOrderedMap([])],
        ["master/gacha/gacha.orderedmap", serializeOrderedMap([
            { key: "1", row: gachaRow() },
        ])],
        ["master/gacha_odds/a-character.orderedmap", nestedOrderedMap("a-character")],
        ["master/gacha_odds/rarity-main.orderedmap", nestedOrderedMap("rarity-main")],
        ["master/gacha_odds/z-character.orderedmap", nestedOrderedMap("z-character")],
    ])
    const incompleteCharacterOutput = converterOutput("character")
    delete incompleteCharacterOutput["character.json"]
    const builder = createDefaultContentTableBuilder({
        convertAdditionalRewards: async () => converterOutput("additional-reward"),
        convertCharacters: async () => incompleteCharacterOutput,
        convertCharacterElections: async () => converterOutput("character-election"),
        convertGachas: async () => converterOutput("gacha"),
        convertShops: async () => converterOutput("shop"),
        convertSkillEffects: async () => converterOutput("skill-effects"),
        importBundledTable: async (_root, tableName) => ({ imported: tableName }),
    })

    await assert.rejects(
        builder.build(defaultBuilderContext(inMemoryArchiveIndex(logicalEntries, []))),
        /missing tables: character\.json/i,
    )
})

test("default release builder bounds parallel reads and imports while preserving order", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const gachaRows = []
    const logicalEntries = new Map([
        ["master/character/character.orderedmap", serializeOrderedMap([])],
        ["master/character/character_text.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election.orderedmap", serializeOrderedMap([])],
        ["master/character_election/character_election_exclude.orderedmap", serializeOrderedMap([])],
        ["master/encyclopedia/encyclopedia.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/action_skill.orderedmap", serializeNestedOrderedMap([])],
        ["master/skill/switched_action_skill.orderedmap", serializeNestedOrderedMap([])],
    ])
    const expectedOddsPaths = []
    for (let index = 0; index < 12; index++) {
        const suffix = String(index).padStart(2, "0")
        const ids = [`a-${suffix}`, `b-${suffix}`, `c-${suffix}`, `r-${suffix}`]
        gachaRows.push({
            key: String(index + 1),
            row: gachaRow({ 11: ids[3], 14: ids[0], 15: ids[1], 16: ids[2] }),
        })
        for (const id of ids) {
            const logicalPath = `master/gacha_odds/${id}.orderedmap`
            expectedOddsPaths.push(logicalPath)
            logicalEntries.set(logicalPath, nestedOrderedMap(id))
        }
    }
    logicalEntries.set("master/gacha/gacha.orderedmap", serializeOrderedMap(gachaRows))
    expectedOddsPaths.sort()

    let activeOddsReads = 0
    let maxOddsReads = 0
    let activeImports = 0
    let maxImports = 0
    const reads = []
    const builder = createDefaultContentTableBuilder({
        convertAdditionalRewards: async () => converterOutput("additional-reward"),
        convertCharacters: async () => converterOutput("character"),
        convertCharacterElections: async () => converterOutput("character-election"),
        convertGachas: async () => converterOutput("gacha"),
        convertShops: async () => converterOutput("shop"),
        convertSkillEffects: async () => converterOutput("skill-effects"),
        importBundledTable: async (_root, tableName) => {
            activeImports++
            maxImports = Math.max(maxImports, activeImports)
            await new Promise(resolve => setTimeout(resolve, 5))
            activeImports--
            return { imported: tableName }
        },
    })
    const archiveIndex = inMemoryArchiveIndex(logicalEntries, reads, async logicalPath => {
        if (!logicalPath.startsWith("master/gacha_odds/")) return
        activeOddsReads++
        maxOddsReads = Math.max(maxOddsReads, activeOddsReads)
        await new Promise(resolve => setTimeout(resolve, 5))
        activeOddsReads--
    })

    const built = await builder.build(defaultBuilderContext(archiveIndex))

    assert.equal(maxOddsReads, 8)
    assert.equal(maxImports, 8)
    assert.deepEqual(
        reads.filter(logicalPath => logicalPath.startsWith("master/gacha_odds/")),
        expectedOddsPaths,
    )
    assert.deepEqual([...built.keys()], TABLE_SOURCES.map(definition => definition.tableName))
})

test("default release builder rejects unknown converter ids before IO", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const bundled = TABLE_SOURCES.find(definition => definition.converterId === "bundled-json")
    const definitions = [{ ...bundled, converterId: "future-converter" }]
    let imports = 0
    const builder = createDefaultContentTableBuilder({
        importBundledTable: async () => {
            imports++
            return {}
        },
    })
    const context = {
        ...defaultBuilderContext({
            has: () => { throw new Error("archive index must not be read") },
            read: async () => { throw new Error("archive index must not be read") },
        }),
        definitions,
    }

    await assert.rejects(builder.build(context), /unsupported converterId: future-converter/)
    assert.equal(imports, 0)
})

test("default release builder rejects missing or ambiguous direct OrderedMap sources", async () => {
    const { createDefaultContentTableBuilder } = require(
        "../src/content/sync/release-builder"
    )
    const direct = TABLE_SOURCES.find(definition => (
        definition.converterId === "ordered-map-json-1"
    ))
    const builder = createDefaultContentTableBuilder()
    const missingContext = {
        ...defaultBuilderContext({
            has: () => false,
            read: async () => { throw new Error("archive must not be read") },
        }),
        definitions: [direct],
    }
    await assert.rejects(
        builder.build(missingContext),
        /orderedmap source is missing/i,
    )

    const ambiguous = {
        ...direct,
        sourceOrderedMaps: [
            ...direct.sourceOrderedMaps,
            "master/fixture/extra.orderedmap",
        ],
    }
    const ambiguousContext = {
        ...defaultBuilderContext(inMemoryArchiveIndex(new Map(), [])),
        definitions: [ambiguous],
    }
    await assert.rejects(
        builder.build(ambiguousContext),
        /direct OrderedMap table must declare one source/i,
    )
})

test("check scans current metadata without locking, materializing, indexing, or writing", async t => {
    const fixture = engineFixture(t, {
        dependencies: {
            acquireLock: async () => { throw new Error("check acquired a lock") },
        },
    })
    const result = await sync(fixture, { mode: "check" })

    assert.deepEqual(result, {
        status: "check",
        action: "synchronize",
        targetVersion: "1.4.54",
        currentVersion: null,
        reason: "missing",
    })
    assert.equal(fixture.calls.scan, 1)
    assert.equal(fixture.calls.materialize, 0)
    assert.equal(fixture.calls.catalog, 0)
    assert.equal(fixture.calls.index, 0)
    assert.equal(fixture.calls.builder, 0)
    assert.equal(fs.existsSync(fixture.paths.contentRootDir), false)
    assert.equal(fs.existsSync(fixture.paths.contentStoreDir), false)
    assert.equal(fs.existsSync(fixture.paths.contentStateDir), false)
})

test("check consumes the store current release snapshot without rereading it", async t => {
    const { paths } = createSandbox(t)
    let snapshotReads = 0
    const current = {
        schemaVersion: 1,
        assetVersion: "1.4.54",
        release: `releases/1.4.54-${"a".repeat(64)}/manifest.json`,
    }
    const manifest = {
        assetVersion: "1.4.54",
        generatorVersion: 1,
        tables: Object.fromEntries(TEST_TABLE_SOURCES.map(definition => [
            definition.tableName,
            {
                scope: definition.scope,
                converterId: definition.converterId,
                converterVersion: definition.converterVersion,
                sources: definition.manifestSources,
            },
        ])),
    }
    const result = await runContentSync({
        projectRoot,
        mode: "check",
        generatorVersion: 1,
    }, {
        resolvePaths: () => paths,
        scanTarget: async () => fakeScan(paths),
        tableSources: TEST_TABLE_SOURCES,
        createStore: () => ({
            readCurrentRelease: async () => {
                snapshotReads++
                return { current, manifest }
            },
            readCurrent: async () => { throw new Error("current pointer was reread") },
            readRelease: async () => { throw new Error("release manifest was reread") },
        }),
    })

    assert.equal(result.reason, "up-to-date")
    assert.equal(snapshotReads, 1)
})

test("normal sync creates a missing release and skips the same asset/generator", async t => {
    const fixture = engineFixture(t)
    const first = await sync(fixture)
    const second = await sync(fixture)

    assert.equal(first.status, "synchronized")
    assert.equal(first.reason, "missing")
    assert.match(first.releaseDigest, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(second, {
        status: "skipped",
        action: "skip",
        targetVersion: "1.4.54",
        currentVersion: "1.4.54",
        reason: "up-to-date",
    })
    assert.equal(fixture.calls.builder, 1)
    assert.deepEqual(fs.readdirSync(fixture.paths.contentStoreDir).sort(), ["objects", "releases"])
    assert.deepEqual(fs.readdirSync(fixture.paths.contentStateDir), ["current.json"])
    assert.equal(fs.existsSync(fixture.paths.contentRootDir), false)
})

test("normal sync rebuilds when the registered table contract changes", async t => {
    const cases = [
        {
            name: "registered table added",
            initial: [TEST_TABLE_SOURCES[0]],
            current: TEST_TABLE_SOURCES,
        },
        {
            name: "registered table removed",
            initial: TEST_TABLE_SOURCES,
            current: [TEST_TABLE_SOURCES[0]],
        },
        {
            name: "converter version changed",
            initial: [TEST_TABLE_SOURCES[0]],
            current: [{
                ...TEST_TABLE_SOURCES[0],
                converterVersion: TEST_TABLE_SOURCES[0].converterVersion + 1,
            }],
        },
    ]

    for (const scenario of cases) {
        await t.test(scenario.name, async t => {
            const fixture = engineFixture(t, {
                tableSources: scenario.initial,
                builderValues: tableValues("initial", scenario.initial),
            })
            await sync(fixture)
            fixture.dependencies.tableSources = scenario.current
            fixture.setBuilderValues(tableValues("current", scenario.current))

            const result = await sync(fixture)
            const manifest = await readCurrentRelease(fixture.store)

            assert.equal(result.status, "synchronized")
            assert.equal(result.action, "synchronize")
            assert.equal(result.reason, "table-registry")
            assert.equal(fixture.calls.builder, 2)
            assert.deepEqual(
                Object.keys(manifest.tables),
                scenario.current.map(definition => definition.tableName),
            )
            for (const definition of scenario.current) {
                assert.equal(
                    manifest.tables[definition.tableName].converterVersion,
                    definition.converterVersion,
                )
            }
        })
    }
})

test("complete legacy ContentPaths keep content and sync lock in one readable root", async t => {
    const { paths: modernPaths, sandbox } = createSandbox(t, "content-sync-legacy-paths-")
    const contentRootDir = path.join(sandbox, "legacy")
    const paths = {
        ...modernPaths,
        layout: "legacy",
        contentRootDir,
        contentStoreDir: contentRootDir,
        contentStateDir: contentRootDir,
    }
    let lockWasInLegacyRoot = false
    const result = await runContentSync({
        projectRoot,
        mode: "normal",
        generatorVersion: 1,
    }, {
        resolvePaths: () => paths,
        acquireLock: async lockRoot => {
            assert.equal(lockRoot, contentRootDir)
            const lock = await acquireContentSyncLock(lockRoot)
            lockWasInLegacyRoot = fs.existsSync(path.join(contentRootDir, "sync.lock"))
            return lock
        },
        scanTarget: async () => fakeScan(paths),
        materializeCatalog: async scan => ({ targetVersion: scan.targetVersion }),
        buildCatalog: input => fakeCatalog(input.targetVersion),
        buildArchiveIndex: async () => ({ marker: "index" }),
        tableBuilder: { build: async () => tableValues("legacy") },
        tableSources: TEST_TABLE_SOURCES,
    })
    const store = new ContentObjectStore(paths)
    const release = await store.readCurrentRelease()

    assert.equal(result.status, "synchronized")
    assert.equal(lockWasInLegacyRoot, true)
    assert.deepEqual(fs.readdirSync(contentRootDir).sort(), ["current.json", "objects", "releases"])
    assert.equal(release.manifest.releaseDigest, result.releaseDigest)
    assert.deepEqual(
        await store.readObject(release.manifest.tables[TEST_TABLE_SOURCES[0].tableName].object),
        { marker: "legacy", tableName: TEST_TABLE_SOURCES[0].tableName },
    )
})

test("generator changes, upgrades, explicit rollbacks, and force trigger rebuilds", async t => {
    const fixture = engineFixture(t)
    const initial = await sync(fixture)
    const generator = await sync(fixture, { generatorVersion: 2 })
    fixture.setTargetVersion("1.5.0")
    const upgrade = await sync(fixture, { generatorVersion: 2 })
    fixture.setTargetVersion("1.4.54")
    const rollback = await sync(fixture, { generatorVersion: 2 })
    const forced = await sync(fixture, { generatorVersion: 2, mode: "force" })

    assert.equal(generator.reason, "generator-version")
    assert.equal(upgrade.reason, "asset-version")
    assert.equal(rollback.reason, "asset-version")
    assert.equal(forced.reason, "forced")
    assert.equal(forced.releaseDigest, rollback.releaseDigest)
    assert.notEqual(generator.releaseDigest, initial.releaseDigest)
    assert.equal(fixture.calls.builder, 5)
})

test("catalog, tables, and summary are stored without physical or absolute paths", async t => {
    const fixture = engineFixture(t, {
        tableSources: TABLE_SOURCES,
        builderValues: tableValues("stable", TABLE_SOURCES),
    })
    const result = await sync(fixture)
    const manifest = await readCurrentRelease(fixture.store)
    assert.ok(manifest)
    assert.equal(manifest.releaseDigest, result.releaseDigest)
    assert.deepEqual(Object.keys(manifest.tables), TABLE_SOURCES.map(item => item.tableName))

    const catalog = await fixture.store.readObject(manifest.catalog.object)
    const summary = await fixture.store.readObject(manifest.summary.object)
    assert.deepEqual(catalog, fakeCatalog("1.4.54"))
    assert.equal(JSON.stringify(summary).includes(fixture.sandbox), false)
    assert.equal(JSON.stringify(summary).includes("physicalPath"), false)
    assert.equal(JSON.stringify(summary).includes("cdnRoot"), false)
    assert.equal(path.isAbsolute(summary.entityListsRelativePath), false)
    assert.deepEqual(summary.archiveSources, { schemaVersion: 1, archives: [] })
})

test("release summary persists exact baseline and patch archive sources", async t => {
    const fixture = engineFixture(t)
    const baselineArchive = { relativePath: "archive-common-full/base.zip" }
    const patchArchive = { relativePath: "archive-common-diff/p55.zip" }
    const catalog = {
        targetVersion: "1.4.55",
        versions: ["1.4.54", "1.4.55"],
        edges: [{ archives: [baselineArchive, patchArchive] }],
        installedBytes: 1,
        entityListsRelativePath: "EntityLists/1.4.55-android_medium.csv",
    }
    fixture.dependencies.scanTarget = async () => ({
        ...fakeScan(fixture.paths, "1.4.55"),
        archives: [
            { ...baselineArchive, source: { kind: "baseline" } },
            { ...patchArchive, source: { kind: "patch", targetVersion: "1.4.55" } },
        ],
    })
    fixture.dependencies.buildCatalog = () => catalog

    await sync(fixture)
    const manifest = await readCurrentRelease(fixture.store)
    const summary = await fixture.store.readObject(manifest.summary.object)
    assert.deepEqual(summary.archiveSources, {
        schemaVersion: 1,
        archives: [
            { relativePath: baselineArchive.relativePath, source: { kind: "baseline" } },
            { relativePath: patchArchive.relativePath, source: { kind: "patch", targetVersion: "1.4.55" } },
        ],
    })
})

test("same-version patch identity changes rebuild instead of reusing the old release", async t => {
    const fixture = engineFixture(t)
    const relativePath = "archive-common-diff/p55.zip"
    let manifestSha256 = "a".repeat(64)
    let archiveMtime = "1"
    const catalogArchive = {
        relativePath,
        compressedBytes: 10,
        sha256: "b".repeat(64),
        layer: "common",
        order: 1,
    }
    const catalog = {
        targetVersion: "1.4.55",
        versions: ["1.4.54", "1.4.55"],
        edges: [{
            fromVersion: "1.4.54",
            toVersion: "1.4.55",
            platform: "android",
            assetSizeKind: "fulfill",
            archives: [catalogArchive],
        }],
        installedBytes: 1,
        entityListsRelativePath: "EntityLists/1.4.55-android_medium.csv",
    }
    fixture.dependencies.scanTarget = async () => ({
        ...fakeScan(fixture.paths, "1.4.55"),
        patchesRoot: path.join(fixture.paths.cdnDir, "patches"),
        patchManifests: [{
            targetVersion: "1.4.55",
            relativePath: "patch-manifest.json",
            physicalPath: path.join(fixture.paths.cdnDir, "patches", "1.4.55", "patch-manifest.json"),
            compressedBytes: 100,
            mtimeMs: "1",
            ctimeMs: "1",
            dev: "2",
            ino: "manifest",
            sha256: manifestSha256,
            patchesRoot: { physicalPath: path.join(fixture.paths.cdnDir, "patches"), mtimeMs: "1", ctimeMs: "1", dev: "2", ino: "root" },
            packageRoot: { physicalPath: path.join(fixture.paths.cdnDir, "patches", "1.4.55"), mtimeMs: "1", ctimeMs: "1", dev: "2", ino: "package" },
        }],
        archives: [{
            ...catalogArchive,
            source: { kind: "patch", targetVersion: "1.4.55" },
            expectedSha256: catalogArchive.sha256,
            kind: "diff",
            fromVersion: "1.4.54",
            toVersion: "1.4.55",
            platform: "android",
            physicalPath: path.join(fixture.paths.cdnDir, "patches", "1.4.55", relativePath),
            mtimeMs: archiveMtime,
            ctimeMs: archiveMtime,
            dev: "2",
            ino: "archive",
        }],
    })
    fixture.dependencies.buildCatalog = () => catalog

    const initial = await sync(fixture)
    const unchanged = await sync(fixture)
    archiveMtime = "2"
    const replacedArchive = await sync(fixture)
    manifestSha256 = "c".repeat(64)
    const replacedManifest = await sync(fixture)

    assert.equal(initial.reason, "missing")
    assert.equal(unchanged.reason, "up-to-date")
    assert.equal(replacedArchive.reason, "source-state")
    assert.equal(replacedManifest.reason, "source-state")
    assert.equal(fixture.calls.builder, 3)
})

test("missing or extra builder tables fail before activation", async t => {
    for (const kind of ["missing", "extra"]) {
        await t.test(kind, async t => {
            const fixture = engineFixture(t)
            const values = tableValues()
            if (kind === "missing") values.delete(TEST_TABLE_SOURCES[0].tableName)
            else values.set("extra.json", {})
            fixture.setBuilderValues(values)
            await assert.rejects(sync(fixture), /table.*(?:missing|extra)|(?:missing|extra).*table/i)
            assert.equal(await fixture.store.readCurrent(), null)
        })
    }
})

test("materialize, catalog build, archive index, table build, object, manifest, and activation failures preserve current", async t => {
    const stages = ["materialize", "catalog", "index", "builder", "object", "manifest", "activate"]
    for (const stage of stages) {
        await t.test(stage, async t => {
            const fixture = engineFixture(t)
            await sync(fixture)
            const before = fs.readFileSync(path.join(fixture.paths.contentStateDir, "current.json"))
            fixture.setTargetVersion("1.5.0")

            if (stage === "materialize") fixture.dependencies.materializeCatalog = async () => { throw new Error(stage) }
            if (stage === "catalog") fixture.dependencies.buildCatalog = () => { throw new Error(stage) }
            if (stage === "index") fixture.dependencies.buildArchiveIndex = async () => { throw new Error(stage) }
            if (stage === "builder") fixture.dependencies.tableBuilder = { build: async () => { throw new Error(stage) } }
            if (stage === "object" || stage === "manifest" || stage === "activate") {
                fixture.dependencies.createStore = () => new Proxy(fixture.store, {
                    get(target, property) {
                        const failingMethod = stage === "object"
                            ? "writeObject"
                            : stage === "manifest" ? "writeRelease" : "activate"
                        if (property === failingMethod) {
                            return async () => { throw new Error(stage) }
                        }
                        const value = Reflect.get(target, property, target)
                        return typeof value === "function" ? value.bind(target) : value
                    },
                })
            }

            await assert.rejects(sync(fixture), new RegExp(stage))
            assert.deepEqual(
                fs.readFileSync(path.join(fixture.paths.contentStateDir, "current.json")),
                before,
            )
        })
    }
})

test("sync and lock release failures preserve both diagnostics", async t => {
    const fixture = engineFixture(t, {
        dependencies: {
            acquireLock: async () => ({
                lockPath: path.join(fixture.paths.contentStateDir, "sync.lock"),
                release: async () => { throw new Error("release failed") },
            }),
            tableBuilder: {
                build: async () => { throw new Error("builder failed") },
            },
        },
    })

    await assert.rejects(
        sync(fixture),
        error => error instanceof ContentSyncCleanupError
            && /builder failed/.test(error.synchronizationError.message)
            && /release failed/.test(error.releaseError.message),
    )
})

test("two concurrent normal syncs build once and the waiter rechecks after locking", async t => {
    let releaseBuilder
    const gate = new Promise(resolve => { releaseBuilder = resolve })
    let enteredBuilder
    const entered = new Promise(resolve => { enteredBuilder = resolve })
    const fixture = engineFixture(t, {
        dependencies: {
            tableBuilder: {
                build: async () => {
                    fixture.calls.builder++
                    enteredBuilder()
                    await gate
                    return tableValues()
                },
            },
        },
    })

    const first = sync(fixture)
    await entered
    const second = sync(fixture)
    await new Promise(resolve => setTimeout(resolve, 30))
    const builderCallsWhileLocked = fixture.calls.builder
    const stateLockExists = fs.existsSync(path.join(fixture.paths.contentStateDir, "sync.lock"))
    const storeLockExists = fs.existsSync(path.join(fixture.paths.contentStoreDir, "sync.lock"))
    const legacyLockExists = fs.existsSync(path.join(fixture.paths.contentRootDir, "sync.lock"))
    releaseBuilder()

    assert.equal((await first).status, "synchronized")
    assert.equal((await second).status, "skipped")
    assert.equal(builderCallsWhileLocked, 1)
    assert.equal(stateLockExists, true)
    assert.equal(storeLockExists, false)
    assert.equal(legacyLockExists, false)
    assert.equal(fixture.calls.builder, 1)
})

test("lock waits, times out clearly, releases by token and identity, and leaves no failed-create file", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-")
    const first = await acquireContentSyncLock(paths.contentStateDir, {
        timeoutMs: 100,
        pollIntervalMs: 5,
    })
    await assert.rejects(
        acquireContentSyncLock(paths.contentStateDir, { timeoutMs: 20, pollIntervalMs: 5 }),
        error => error instanceof ContentSyncLockError
            && error.code === "CONTENT_SYNC_LOCK_TIMEOUT"
            && /remove.*manually|人工删除/i.test(error.message),
    )
    await first.release()
    assert.equal(fs.existsSync(path.join(paths.contentStateDir, "sync.lock")), false)

    await assert.rejects(
        acquireContentSyncLock(paths.contentStateDir, {
            timeoutMs: 20,
            writeLock: async () => { throw new Error("write failed") },
        }),
        /write failed/,
    )
    assert.equal(fs.existsSync(path.join(paths.contentStateDir, "sync.lock")), false)

    const lock = await acquireContentSyncLock(paths.contentStateDir)
    const lockPath = path.join(paths.contentStateDir, "sync.lock")
    fs.unlinkSync(lockPath)
    fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, token: "other", pid: 1 }))
    await assert.rejects(lock.release(), /identity|token|replaced/i)
    assert.equal(fs.existsSync(lockPath), true)
})

test("lock rejects a symlink and reports an existing legacy lock", async t => {
    const { paths, sandbox } = createSandbox(t, "content-sync-lock-link-")
    fs.mkdirSync(paths.contentStateDir)
    const outside = path.join(sandbox, "outside.lock")
    fs.writeFileSync(outside, "outside")
    fs.symlinkSync(outside, path.join(paths.contentStateDir, "sync.lock"))
    await assert.rejects(
        acquireContentSyncLock(paths.contentStateDir, { timeoutMs: 10, pollIntervalMs: 2 }),
        /symlink|symbolic/i,
    )
    assert.equal(fs.readFileSync(outside, "utf8"), "outside")
})

test("lock creation preserves the operation error when handle cleanup also fails", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-cleanup-")
    await assert.rejects(
        acquireContentSyncLock(paths.contentStateDir, {
            writeLock: async handle => {
                const close = handle.close.bind(handle)
                handle.close = async () => {
                    await close()
                    throw new Error("close failed")
                }
                throw new Error("write failed")
            },
        }),
        error => error instanceof ContentSyncLockCleanupError
            && /write failed/.test(error.operationError.message)
            && error.cleanupErrors.some(item => /close failed/.test(item.message)),
    )
    assert.equal(fs.existsSync(path.join(paths.contentStateDir, "sync.lock")), false)
})

test("lock waits through the owner's create/write window and diagnoses legacy files", async t => {
    const { paths } = createSandbox(t, "content-sync-lock-race-")
    let finishWrite
    const writeGate = new Promise(resolve => { finishWrite = resolve })
    let writeStarted
    const started = new Promise(resolve => { writeStarted = resolve })
    const firstPromise = acquireContentSyncLock(paths.contentStateDir, {
        timeoutMs: 500,
        pollIntervalMs: 5,
        writeLock: async (handle, bytes) => {
            writeStarted()
            await writeGate
            await handle.writeFile(bytes)
        },
    })
    await started
    const secondPromise = acquireContentSyncLock(paths.contentStateDir, {
        timeoutMs: 500,
        pollIntervalMs: 5,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    finishWrite()
    const first = await firstPromise
    await first.release()
    const second = await secondPromise
    await second.release()

    fs.writeFileSync(path.join(paths.contentStateDir, "sync.lock"), "old lock")
    await assert.rejects(
        acquireContentSyncLock(paths.contentStateDir, { timeoutMs: 10, pollIntervalMs: 2 }),
        error => error instanceof ContentSyncLockError
            && error.code === "CONTENT_SYNC_LOCK_LEGACY"
            && /remove|人工删除/i.test(error.message),
    )
})

test("CLI parses mutually exclusive modes, returns exit codes, and never prints absolute paths", async () => {
    assert.deepEqual(parseContentSyncArguments([]), { mode: "normal" })
    assert.deepEqual(parseContentSyncArguments(["--check"]), { mode: "check" })
    assert.deepEqual(parseContentSyncArguments(["--force"]), { mode: "force" })
    assert.throws(() => parseContentSyncArguments(["--check", "--force"]), /mutually|互斥/i)
    assert.throws(() => parseContentSyncArguments(["--unknown"]), /unknown|未知/i)

    let stdout = ""
    let stderr = ""
    let exitCode = null
    const success = await runContentSyncCli(["--check"], {
        projectRoot,
        runSync: async options => ({
            status: "check",
            action: "skip",
            targetVersion: "1.4.54",
            currentVersion: "1.4.54",
            reason: "up-to-date",
            mode: options.mode,
        }),
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })
    assert.equal(success, 0)
    assert.equal(exitCode, 0)
    assert.equal(stderr, "")
    assert.deepEqual(JSON.parse(stdout), {
        status: "check",
        action: "skip",
        targetVersion: "1.4.54",
        currentVersion: "1.4.54",
        reason: "up-to-date",
    })

    stdout = ""
    stderr = ""
    const failure = await runContentSyncCli([], {
        projectRoot,
        runSync: async () => {
            throw new Error(
                `/private/secret failed in ${projectRoot}; `
                + `'C:\\Users\\Alice\\Secret Folder\\config.json'; `
                + `'\\\\server\\share\\Private Folder\\catalog.json'`,
            )
        },
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })
    assert.equal(failure, 1)
    assert.equal(exitCode, 1)
    assert.equal(stdout, "")
    assert.equal(stderr.includes(projectRoot), false)
    assert.equal(stderr.includes("/private/secret"), false)
    assert.equal(stderr.includes("Alice"), false)
    assert.equal(stderr.includes("Secret Folder"), false)
    assert.equal(stderr.includes("server\\share"), false)
    assert.equal(stderr.includes("Private Folder"), false)
})

test("package and quick workflow expose content sync", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.equal(
        packageJson.scripts["content:sync"],
        "node tools/content_sync.cjs",
    )
    assert.ok(TEST_GROUPS["quick:content"].tests.includes("tools/content_sync.test.cjs"))
    assert.equal(TEST_GROUPS["quick:content"].timeoutMs, 60_000)
    assert.ok(fs.existsSync(path.join(projectRoot, "tools", "content_sync.cjs")))
})

test("content sync loads an optional project env file without requiring one", () => {
    const { loadOptionalProjectEnv } = require("./content_sync.cjs")
    const loaded = []

    assert.equal(loadOptionalProjectEnv(projectRoot, {
        existsSync: () => false,
        loadEnvFile: filePath => { loaded.push(filePath) },
    }), false)
    assert.deepEqual(loaded, [])

    assert.equal(loadOptionalProjectEnv(projectRoot, {
        existsSync: () => true,
        loadEnvFile: filePath => { loaded.push(filePath) },
    }), true)
    assert.deepEqual(loaded, [path.join(projectRoot, ".env")])
})

test("content sync bootstrap hides initialization paths", async () => {
    const { runContentSyncBootstrap } = require("./content_sync.cjs")
    let stderr = ""
    let exitCode = null
    const result = await runContentSyncBootstrap({
        projectRoot,
        loadEnv: () => { throw new Error(`/private/secret-config failed in ${projectRoot}`) },
        stderr: { write: value => { stderr += value } },
        setExitCode: value => { exitCode = value },
    })

    assert.equal(result, 1)
    assert.equal(exitCode, 1)
    assert.match(stderr, /CONTENT_SYNC_BOOTSTRAP_FAILED/)
    assert.equal(stderr.includes(projectRoot), false)
    assert.equal(stderr.includes("/private/secret-config"), false)
})

test("content sync never modifies the gacha seed catalog", () => {
    const currentDigest = crypto.createHash("sha256")
        .update(fs.readFileSync(seedCatalogManifestPath))
        .digest("hex")
    assert.equal(currentDigest, seedCatalogManifestDigest)
})
