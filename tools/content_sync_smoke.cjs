#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { isDeepStrictEqual } = require("node:util")

const EXPECTED_VERSION = "1.4.54"
const EXPECTED_TABLE_COUNT = 94
const EXPECTED_FEATURE_DIGEST = "sha256:21898330b538f6c60a0c8114a15f8e247934bea46a104ca4711cc72cde761bf4"
const EXPECTED_FEATURE_COUNTS = Object.freeze({
    outer: 543,
    nonemptyOuter: 543,
    entries: 2866,
    rows: 2866,
    nonemptyFields: 12236,
    noneFields: 541,
})
const EXPECTED_OFFICIAL_SHOP_COUNTS = Object.freeze({
    bossOfficial: 6566,
    bossBundled: 6132,
    bossDifference: 434,
    starGrainRelease: 75,
    starGrainBundled: 74,
})
const SHOP_TABLE_NAMES = Object.freeze([
    "general_shop.json",
    "event_item_shop.json",
    "event_item_shop_id_map.json",
    "boss_coin_shop.json",
    "boss_coin_shop_item_category_map.json",
    "star_grain_shop.json",
    "treasure_shop.json",
    "equipment_enhancement_shop.json",
])

class ContentSyncSmokeError extends Error {
    constructor(code, message, options) {
        super(message, options)
        this.name = "ContentSyncSmokeError"
        this.code = code
    }
}

function argumentError(message) {
    throw new ContentSyncSmokeError("CONTENT_SYNC_SMOKE_ARGUMENTS", message)
}

function parseSmokeArguments(argv) {
    const values = {}
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index]
        const value = argv[index + 1]
        if ((name !== "--cdn-root" && name !== "--content-root") || !value) {
            argumentError("必须显式提供 --cdn-root 与 --content-root")
        }
        const key = name === "--cdn-root" ? "cdnRoot" : "contentRoot"
        if (values[key] !== undefined) argumentError(`参数不能重复：${name}`)
        values[key] = value
    }
    if (values.cdnRoot === undefined || values.contentRoot === undefined) {
        argumentError("必须显式提供 --cdn-root 与 --content-root")
    }
    return values
}

function resolvePhysicalPath(filePath) {
    const missing = []
    let existing = path.resolve(filePath)
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing)
        if (parent === existing) throw new Error("找不到路径的现有父目录")
        missing.unshift(path.basename(existing))
        existing = parent
    }
    return path.resolve(fs.realpathSync(existing), ...missing)
}

function overlaps(left, right) {
    function sameOrDescendant(parent, candidate) {
        const relative = path.relative(parent, candidate)
        return relative === ""
            || (!path.isAbsolute(relative)
                && relative !== ".."
                && !relative.startsWith(`..${path.sep}`))
    }
    return sameOrDescendant(left, right) || sameOrDescendant(right, left)
}

function requireAbsolute(value, argumentName) {
    if (!value || !path.isAbsolute(value)) argumentError(`${argumentName} 必须是绝对路径`)
    return resolvePhysicalPath(value)
}

function contentRootError(message) {
    throw new ContentSyncSmokeError("CONTENT_SYNC_SMOKE_CONTENT_ROOT", message)
}

function directoryIdentity(stat) {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
    }
}

function sameDirectoryIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function isPrivateDirectoryMode(stat) {
    return (Number(stat.mode) & 0o777) === 0o700
}

function resolveContentRoot(value) {
    if (!value || !path.isAbsolute(value)) argumentError("--content-root 必须是绝对路径")
    const lexicalRoot = path.resolve(value)
    let stat
    try {
        stat = fs.lstatSync(lexicalRoot, { bigint: true })
    } catch (error) {
        if (error?.code !== "ENOENT") contentRootError("无法检查 content root")
        const parent = path.dirname(lexicalRoot)
        let parentStat
        try {
            parentStat = fs.lstatSync(parent, { bigint: true })
        } catch {
            return contentRootError("content root 的直接父目录必须已存在")
        }
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
            contentRootError("content root 的直接父目录必须是普通目录")
        }
        return {
            contentRoot: path.join(fs.realpathSync(parent), path.basename(lexicalRoot)),
            contentRootExisted: false,
        }
    }
    if (stat.isSymbolicLink()) contentRootError("content root 不能是符号链接")
    if (!stat.isDirectory()) contentRootError("content root 必须是普通目录")
    if (!isPrivateDirectoryMode(stat)) contentRootError("content root 权限必须是 0700")
    return {
        contentRoot: fs.realpathSync(lexicalRoot),
        contentRootExisted: true,
        contentRootEmpty: fs.readdirSync(lexicalRoot).length === 0,
        contentRootIdentity: directoryIdentity(stat),
    }
}

function resolveSmokePaths({ projectRoot, cdnRoot, contentRoot }) {
    const resolvedProject = requireAbsolute(projectRoot, "projectRoot")
    const resolvedCdn = requireAbsolute(cdnRoot, "--cdn-root")
    const resolvedContentRoot = resolveContentRoot(contentRoot)
    const resolvedContent = resolvedContentRoot.contentRoot
    const protectedRoots = [
        ["project", resolvedProject],
        ["database", resolvePhysicalPath(path.join(resolvedProject, ".database"))],
        ["CDN", resolvedCdn],
    ]
    const exactMatch = protectedRoots.find(([, protectedRoot]) => (
        resolvedContent === protectedRoot
    ))
    if (exactMatch) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_PATH_OVERLAP",
            `content root 不得与 ${exactMatch[0]} 路径重叠`,
        )
    }
    for (const [name, protectedRoot] of protectedRoots) {
        if (overlaps(resolvedContent, protectedRoot)) {
            throw new ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_PATH_OVERLAP",
                `content root 不得与 ${name} 路径重叠`,
            )
        }
    }
    if (path.basename(resolvedCdn).toLowerCase() === "cn") {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_CDN_ROOT",
            "--cdn-root 必须指向包含 cn 的父目录",
        )
    }
    if (resolvedContentRoot.contentRootExisted
        && !resolvedContentRoot.contentRootEmpty) {
        contentRootError("content root 必须为空")
    }
    return {
        projectRoot: resolvedProject,
        cdnRoot: resolvedCdn,
        contentRoot: resolvedContent,
        contentRootExisted: resolvedContentRoot.contentRootExisted,
        contentRootIdentity: resolvedContentRoot.contentRootIdentity,
        env: {
            CDN_DIR: resolvedCdn,
            CONTENT_DIR: path.join(resolvedContent, "release"),
            CONTENT_STORE_DIR: path.join(resolvedContent, "store"),
            CONTENT_STATE_DIR: path.join(resolvedContent, "state"),
            CONTENT_RUNTIME_DIR: path.join(resolvedContent, "runtime"),
        },
    }
}

function inspectPrivateDirectory(directory, label) {
    let stat
    try {
        stat = fs.lstatSync(directory, { bigint: true })
    } catch (error) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
            `${label} 不可读取`,
            { cause: error },
        )
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        contentRootError(`${label} 必须是普通目录且不能是符号链接`)
    }
    if (!isPrivateDirectoryMode(stat)) contentRootError(`${label} 权限必须是 0700`)
    return { identity: directoryIdentity(stat), realpath: fs.realpathSync(directory) }
}

function prepareContentRoot(paths) {
    if (paths.contentRootExisted) {
        const inspected = inspectPrivateDirectory(paths.contentRoot, "content root")
        if (!sameDirectoryIdentity(inspected.identity, paths.contentRootIdentity)
            || fs.readdirSync(paths.contentRoot).length !== 0) {
            contentRootError("content root 在 smoke 启动前已不再是空普通目录")
        }
    } else {
        try {
            fs.mkdirSync(paths.contentRoot, { mode: 0o700 })
        } catch (error) {
            throw new ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_CONTENT_ROOT",
                "无法创建专用 content root",
                { cause: error },
            )
        }
    }

    const root = inspectPrivateDirectory(paths.contentRoot, "content root")
    if (fs.readdirSync(paths.contentRoot).length !== 0) {
        contentRootError("content root 在建立派生目录前必须为空")
    }
    const derived = {}
    for (const [name, directory] of [
        ["release", paths.env.CONTENT_DIR],
        ["store", paths.env.CONTENT_STORE_DIR],
        ["state", paths.env.CONTENT_STATE_DIR],
        ["runtime", paths.env.CONTENT_RUNTIME_DIR],
    ]) {
        fs.mkdirSync(directory, { mode: 0o700 })
        const inspected = inspectPrivateDirectory(directory, `content ${name} 目录`)
        const relative = path.relative(root.realpath, inspected.realpath)
        if (relative !== name || path.isAbsolute(relative)) {
            contentRootError(`content ${name} 目录逃逸`)
        }
        derived[name] = {
            path: directory,
            realpath: inspected.realpath,
            identity: inspected.identity,
        }
    }
    const sandbox = { root, derived }
    verifyContentSandbox(paths, sandbox)
    return sandbox
}

function verifyContentSandbox(paths, sandbox) {
    const root = inspectPrivateDirectory(paths.contentRoot, "content root")
    if (!sameDirectoryIdentity(root.identity, sandbox.root.identity)
        || root.realpath !== sandbox.root.realpath) {
        contentRootError("content root identity 已变化")
    }
    const expectedEntries = Object.keys(sandbox.derived).sort()
    const actualEntries = fs.readdirSync(paths.contentRoot).sort()
    if (!isDeepStrictEqual(actualEntries, expectedEntries)) {
        contentRootError("content root 包含工具之外的项目")
    }
    for (const [name, expected] of Object.entries(sandbox.derived)) {
        const inspected = inspectPrivateDirectory(expected.path, `content ${name} 目录`)
        const relative = path.relative(root.realpath, inspected.realpath)
        if (!sameDirectoryIdentity(inspected.identity, expected.identity)
            || inspected.realpath !== expected.realpath
            || relative !== name
            || path.isAbsolute(relative)) {
            contentRootError(`content ${name} 目录 identity 或边界已变化`)
        }
    }
}

function baselineError(code, message) {
    throw new ContentSyncSmokeError(code, message)
}

function validateCharacters({
    bundled,
    release,
    expectedSkillCounts,
    expectedCount,
    expectedUpgradeCount,
    expectedTwoSkillCount,
}) {
    const bundledIds = Object.keys(bundled).sort()
    const releaseIds = Object.keys(release).sort()
    const expectedIds = Object.keys(expectedSkillCounts).sort()
    if (releaseIds.length !== expectedCount
        || JSON.stringify(releaseIds) !== JSON.stringify(bundledIds)
        || JSON.stringify(releaseIds) !== JSON.stringify(expectedIds)) {
        baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", "角色 ID 集合或数量不一致")
    }

    const upgrades = []
    let twoSkillCharacters = 0
    for (const id of releaseIds) {
        const actual = release[id]
        const previous = bundled[id]
        for (const field of ["name", "rarity", "element"]) {
            if (actual[field] !== previous[field]) {
                baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", `角色 ${id} 的 ${field} 不一致`)
            }
        }
        if (actual.skill_count !== expectedSkillCounts[id]) {
            baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", `角色 ${id} 的 skill_count 不在允许基线内`)
        }
        if (previous.skill_count !== actual.skill_count) {
            if (previous.skill_count !== 3 || actual.skill_count !== 6) {
                baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", `角色 ${id} 出现未允许的 skill_count 差异`)
            }
            upgrades.push(id)
        }
        if (previous.skill_count === 2) {
            if (actual.skill_count !== 2) {
                baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", `角色 ${id} 未保持 skill_count=2`)
            }
            twoSkillCharacters += 1
        }
    }
    if (upgrades.length !== expectedUpgradeCount || twoSkillCharacters !== expectedTwoSkillCount) {
        baselineError("CONTENT_SYNC_SMOKE_CHARACTER_BASELINE", "角色 skill_count 差异计数不一致")
    }
    return {
        characters: releaseIds.length,
        skillCountUpgrades: upgrades.length,
        twoSkillCharacters,
    }
}

function validateReleaseClosure({
    syncResult,
    snapshot,
    repositoryInfo,
    catalog,
    registryNames,
    expectedVersion,
    expectedTableCount,
}) {
    const fail = message => baselineError("CONTENT_SYNC_SMOKE_RELEASE_CLOSURE", message)
    if (syncResult.status !== "synchronized" || syncResult.reason !== "forced") {
        fail("smoke 必须完成 force sync")
    }
    const versions = [
        syncResult.targetVersion,
        snapshot?.current?.assetVersion,
        snapshot?.manifest?.assetVersion,
        repositoryInfo?.assetVersion,
        catalog?.targetVersion,
    ]
    if (repositoryInfo?.source !== "release"
        || versions.some(version => version !== expectedVersion)) {
        fail("Release、Repository 与 Catalog 版本不一致")
    }
    const releaseNames = Object.keys(snapshot.manifest.tables).sort()
    const expectedNames = [...registryNames].sort()
    if (releaseNames.length !== expectedTableCount
        || expectedNames.length !== expectedTableCount
        || !isDeepStrictEqual(releaseNames, expectedNames)) {
        fail("Release 表集合与 Registry 不一致")
    }
    const summary = snapshot.objects[snapshot.manifest.summary.object]
    if (!summary || summary.counts?.tables !== expectedTableCount) {
        fail("Release summary 表计数不一致")
    }
    const referenced = [
        snapshot.manifest.catalog.object,
        snapshot.manifest.summary.object,
        ...releaseNames.map(name => snapshot.manifest.tables[name].object),
    ]
    if (referenced.some(digest => snapshot.objects[digest] === undefined)) {
        fail("Release 存在未闭合的对象引用")
    }
    if (snapshot.objects[snapshot.manifest.catalog.object] !== catalog) {
        fail("Catalog 不是 current Release 中已读取的对象")
    }
    return { assetVersion: expectedVersion, tables: releaseNames.length }
}

function drawableSignature(runtime) {
    const banners = Object.entries(runtime).sort(([left], [right]) => (
        left.length - right.length || left.localeCompare(right)
    ))
    return banners.map(([gachaId, gacha]) => ({
        gachaId,
        type: gacha.type,
        pools: Object.entries(gacha.pool ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([pool, items]) => ({
                pool,
                items: items.map(item => ({
                    id: item.id,
                    rank: item.rank,
                    weight: item.odds,
                })).sort((left, right) => (
                    left.id - right.id || left.rank - right.rank || left.weight - right.weight
                )),
            })),
    }))
}

function inspectFeatureContent(feature, expectedGachaIds) {
    const outerIds = Object.keys(feature).sort()
    const knownGachaIds = new Set(expectedGachaIds)
    if (outerIds.some(gachaId => !knownGachaIds.has(gachaId))) return null
    let nonemptyOuter = 0
    let entries = 0
    let rows = 0
    let nonemptyFields = 0
    let noneFields = 0
    for (const nested of Object.values(feature)) {
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null
        const nestedValues = Object.values(nested)
        if (nestedValues.length > 0) nonemptyOuter += 1
        entries += nestedValues.length
        for (const value of nestedValues) {
            if (!Array.isArray(value)) return null
            rows += value.length
            for (const row of value) {
                if (!Array.isArray(row) || row.length !== 9) return null
                nonemptyFields += row.filter(field => field !== "" && field !== "(None)").length
                noneFields += row.filter(field => field === "(None)").length
            }
        }
    }
    return { outer: outerIds.length, nonemptyOuter, entries, rows, nonemptyFields, noneFields }
}

function validateGachas({
    bundledRaw,
    releaseRaw,
    bundledCampaigns,
    releaseCampaigns,
    bundledRuntime,
    releaseRuntime,
    releaseFeature,
    expectedGachaCount,
    expectedCampaignCount,
    expectedFeature,
    releaseFeatureDigest,
    expectedFeatureDigest,
}) {
    const fail = message => baselineError("CONTENT_SYNC_SMOKE_GACHA_BASELINE", message)
    if (Object.keys(releaseRaw).length !== expectedGachaCount
        || !isDeepStrictEqual(releaseRaw, bundledRaw)) {
        fail("卡池 cdndata 原始行不一致")
    }
    if (Object.keys(releaseCampaigns).length !== expectedCampaignCount
        || !isDeepStrictEqual(releaseCampaigns, bundledCampaigns)) {
        fail("卡池 campaign 映射不一致")
    }
    const bundledDrawable = drawableSignature(bundledRuntime)
    const releaseDrawable = drawableSignature(releaseRuntime)
    if (releaseDrawable.length !== expectedGachaCount
        || !isDeepStrictEqual(releaseDrawable, bundledDrawable)) {
        fail("可抽取角色或装备的类型、ID、数量、原始 weight 不一致")
    }
    const featureStats = inspectFeatureContent(releaseFeature, Object.keys(releaseRaw))
    if (!featureStats || !isDeepStrictEqual(featureStats, expectedFeature)) {
        fail("官方 feature content nested 形状或稳定计数不一致")
    }
    if (releaseFeatureDigest !== expectedFeatureDigest) {
        fail("官方 feature content canonical digest 不一致")
    }
    const drawableEntries = releaseDrawable.reduce((bannerTotal, banner) => (
        bannerTotal + banner.pools.reduce((poolTotal, pool) => poolTotal + pool.items.length, 0)
    ), 0)
    return {
        gachas: expectedGachaCount,
        campaigns: expectedCampaignCount,
        featureEntries: featureStats.entries,
        drawableEntries,
    }
}

function sortedKeys(value) {
    return Object.keys(value).sort((left, right) => (
        left.length - right.length || left.localeCompare(right)
    ))
}

function eventShopShape(table) {
    return sortedKeys(table).map(eventType => ({
        eventType,
        events: sortedKeys(table[eventType]).map(eventId => ({
            eventId,
            itemIds: sortedKeys(table[eventType][eventId]),
        })),
    }))
}

function bossShopShape(table) {
    return sortedKeys(table).map(categoryId => ({
        categoryId,
        itemIds: sortedKeys(table[categoryId]),
    }))
}

function equipmentShape(table) {
    return sortedKeys(table).map(id => [id, table[id].shopCategoryId])
}

function leafCount(shape, collectionName) {
    return shape.reduce((total, entry) => total + entry[collectionName].length, 0)
}

function officialBossShape(bundledTable, rows) {
    const categories = Object.fromEntries(sortedKeys(bundledTable).map(categoryId => (
        [categoryId, []]
    )))
    const itemCategoryMap = {}
    for (const id of sortedKeys(rows)) {
        const value = rows[id]
        const categoryId = value?.[0]?.[0]
        if (value?.length !== 1 || categories[categoryId] === undefined) return null
        categories[categoryId].push(id)
        itemCategoryMap[id] = Number(categoryId)
    }
    return {
        nested: sortedKeys(categories).map(categoryId => ({
            categoryId,
            itemIds: categories[categoryId],
        })),
        itemCategoryMap,
    }
}

function validateShops({
    bundled,
    release,
    rushEventIds,
    officialBossRows,
    officialOnlyStarGrainIds = [],
    expectedOfficialCounts,
}) {
    const fail = message => baselineError("CONTENT_SYNC_SMOKE_SHOP_BASELINE", message)
    const flatTables = [
        "general_shop.json",
        "treasure_shop.json",
    ]
    for (const tableName of flatTables) {
        if (!isDeepStrictEqual(sortedKeys(release[tableName]), sortedKeys(bundled[tableName]))) {
            fail(`${tableName} 的 ID 集合不一致`)
        }
    }
    const expectedStarGrainIds = [
        ...new Set([
            ...sortedKeys(bundled["star_grain_shop.json"]),
            ...officialOnlyStarGrainIds,
        ]),
    ].sort((left, right) => left.length - right.length || left.localeCompare(right))
    if (!isDeepStrictEqual(
        sortedKeys(release["star_grain_shop.json"]),
        expectedStarGrainIds,
    )) {
        fail("star_grain_shop.json 的 ID 集合不一致")
    }
    const bundledStarGrainIds = sortedKeys(bundled["star_grain_shop.json"])
    const releaseStarGrainIds = sortedKeys(release["star_grain_shop.json"])
    const starGrainDifference = releaseStarGrainIds.filter(id => (
        !bundledStarGrainIds.includes(id)
    ))
    if (!isDeepStrictEqual(starGrainDifference, [...officialOnlyStarGrainIds].sort())) {
        fail("Star Grain 官方差集不一致")
    }
    const bundledEvent = eventShopShape(bundled["event_item_shop.json"])
    const releaseEvent = eventShopShape(release["event_item_shop.json"])
    if (!isDeepStrictEqual(releaseEvent, bundledEvent)
        || !isDeepStrictEqual(
            release["event_item_shop_id_map.json"],
            bundled["event_item_shop_id_map.json"],
        )) {
        fail("Event 商店的 type/event/item 嵌套集合不一致")
    }
    const bundledBoss = bossShopShape(bundled["boss_coin_shop.json"])
    const releaseBoss = bossShopShape(release["boss_coin_shop.json"])
    const expectedOfficialBoss = officialBossRows === undefined
        ? {
            nested: bundledBoss,
            itemCategoryMap: bundled["boss_coin_shop_item_category_map.json"],
        }
        : officialBossShape(bundled["boss_coin_shop.json"], officialBossRows)
    const bundledBossIds = sortedKeys(bundled["boss_coin_shop_item_category_map.json"])
    const releaseBossIds = sortedKeys(release["boss_coin_shop_item_category_map.json"])
    const officialBossIds = officialBossRows === undefined
        ? bundledBossIds
        : sortedKeys(officialBossRows)
    const officialBossDifference = officialBossIds.filter(id => !bundledBossIds.includes(id))
    const bundledBossMissingFromOfficial = bundledBossIds.filter(id => !officialBossIds.includes(id))
    if (expectedOfficialBoss === null
        || !isDeepStrictEqual(releaseBoss, expectedOfficialBoss.nested)
        || !isDeepStrictEqual(
            release["boss_coin_shop_item_category_map.json"],
            expectedOfficialBoss.itemCategoryMap,
        )) {
        fail("Boss 商店的 category/item 嵌套集合不一致")
    }
    if (!isDeepStrictEqual(releaseBossIds, officialBossIds)
        || bundledBossMissingFromOfficial.length !== 0) {
        fail("Boss 官方 raw/bundled ID 边界不一致")
    }
    if (expectedOfficialCounts !== undefined) {
        if (officialBossIds.length !== expectedOfficialCounts.bossOfficial
            || bundledBossIds.length !== expectedOfficialCounts.bossBundled
            || officialBossDifference.length !== expectedOfficialCounts.bossDifference
            || releaseStarGrainIds.length !== expectedOfficialCounts.starGrainRelease
            || bundledStarGrainIds.length !== expectedOfficialCounts.starGrainBundled) {
            fail("Boss 或 Star Grain 显式记录数不一致")
        }
    }
    const bundledEquipment = equipmentShape(bundled["equipment_enhancement_shop.json"])
    const releaseEquipment = equipmentShape(release["equipment_enhancement_shop.json"])
    if (!isDeepStrictEqual(releaseEquipment, bundledEquipment)) {
        fail("Equipment 商店的 ID/category 集合不一致")
    }
    for (const eventId of rushEventIds) {
        const hasRows = Object.values(release["event_item_shop.json"]).some(events => (
            Object.keys(events[String(eventId)] ?? {}).length > 0
        ))
        if (hasRows) fail("Rush 700011..700017 官方独立商品必须保持为空")
    }
    return {
        general: sortedKeys(release["general_shop.json"]).length,
        event: leafCount(releaseEvent.flatMap(type => type.events), "itemIds"),
        boss: leafCount(releaseBoss, "itemIds"),
        starGrain: sortedKeys(release["star_grain_shop.json"]).length,
        treasure: sortedKeys(release["treasure_shop.json"]).length,
        equipment: releaseEquipment.length,
    }
}

function assertEnvironmentUnchanged(before, after) {
    for (const [label, left, right] of [
        ["Git HEAD", before.git?.head, after.git?.head],
        ["Git tracked HEAD diff", before.git?.tracked, after.git?.tracked],
        ["Git staged diff", before.git?.staged, after.git?.staged],
        ["Git unstaged diff", before.git?.unstaged, after.git?.unstaged],
        ["Git untracked 内容", before.git?.untracked, after.git?.untracked],
        ["seed 状态", before.seeds, after.seeds],
        ["database 内容", before.database, after.database],
        ["CDN 原始归档元数据", before.cdn?.archives, after.cdn?.archives],
        ["CDN EntityLists", before.cdn?.entityLists, after.cdn?.entityLists],
    ]) {
        if (!isDeepStrictEqual(left, right)) {
            baselineError("CONTENT_SYNC_SMOKE_SOURCE_MUTATED", `${label} 在 smoke 前后发生变化`)
        }
    }
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex")
}

function runGitSnapshotCommand(projectRoot, args, dependencies = {}) {
    const spawn = dependencies.spawn ?? spawnSync
    const result = spawn(
        "git",
        args,
        {
            cwd: projectRoot,
            encoding: null,
            maxBuffer: 64 * 1024 * 1024,
        },
    )
    if (result.error?.code === "ENOBUFS") {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_GIT_TOO_LARGE",
            "Git dirty binary diff 超过 64MiB 快照限制",
        )
    }
    if (result.status !== 0) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_GIT_STATUS",
            "无法读取 Git 来源快照",
        )
    }
    return result.stdout
}

function sameFileStat(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
}

function stableFileRecord(root, relativePath, includeTimes = false) {
    const filePath = path.resolve(root, relativePath)
    if (!overlaps(path.resolve(root), filePath)
        || path.relative(path.resolve(root), filePath).startsWith(`..${path.sep}`)) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_SOURCE_UNSAFE",
            "来源快照路径逃逸",
        )
    }
    let before
    try {
        before = fs.lstatSync(filePath, { bigint: true })
    } catch (error) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE",
            "来源文件在快照期间消失",
            { cause: error },
        )
    }
    if (before.isSymbolicLink()) {
        return `L\0${relativePath}\0${fs.readlinkSync(filePath)}`
    }
    if (!before.isFile()) return `O\0${relativePath}\0${before.mode.toString()}`

    let handle
    let contentDigest
    try {
        handle = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const opened = fs.fstatSync(handle, { bigint: true })
        if (!opened.isFile() || !sameFileStat(before, opened)) {
            throw new Error("identity changed while opening")
        }
        const contentHash = createHash("sha256")
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        let bytesRead
        do {
            bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)
            if (bytesRead > 0) contentHash.update(buffer.subarray(0, bytesRead))
        } while (bytesRead > 0)
        contentDigest = contentHash.digest("hex")
        const read = fs.fstatSync(handle, { bigint: true })
        const after = fs.lstatSync(filePath, { bigint: true })
        if (!sameFileStat(opened, read) || !sameFileStat(read, after)) {
            throw new Error("identity changed while reading")
        }
    } catch (error) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE",
            "来源文件在快照读取期间变化",
            { cause: error },
        )
    } finally {
        if (handle !== undefined) fs.closeSync(handle)
    }
    const metadata = [
        before.mode.toString(),
        before.size.toString(),
        ...(includeTimes ? [
            before.dev.toString(),
            before.ino.toString(),
            before.mtimeNs.toString(),
            before.ctimeNs.toString(),
        ] : []),
    ]
    return `F\0${relativePath}\0${metadata.join("\0")}\0${contentDigest}`
}

function listSnapshotFiles(root, predicate) {
    const files = []
    function walk(directory, prefix) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
            const absolutePath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                walk(absolutePath, relativePath)
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                if (predicate(relativePath, entry)) files.push(relativePath)
            }
        }
    }
    walk(root, "")
    return files.sort((left, right) => left.localeCompare(right))
}

function directorySnapshot(root, options = {}) {
    const predicate = options.predicate ?? (() => true)
    const sentinels = options.sentinels ?? []
    let rootStat
    try {
        rootStat = fs.lstatSync(root)
    } catch (error) {
        if (error?.code !== "ENOENT") throw error
        const missing = ["ROOT:MISSING", ...sentinels.map(name => `M\0${name}`)].sort()
        return { digest: sha256(missing.join("\n")), count: 0 }
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_SOURCE_UNSAFE",
            "来源快照根必须是普通目录",
        )
    }
    const files = listSnapshotFiles(root, predicate)
    const records = files.map(relativePath => (
        stableFileRecord(root, relativePath, options.includeTimes === true)
    ))
    for (const sentinel of sentinels) {
        if (!files.includes(sentinel)) records.push(`M\0${sentinel}`)
    }
    records.sort()
    return { digest: sha256(records.join("\n")), count: files.length }
}

function untrackedSnapshot(projectRoot) {
    const output = runGitSnapshotCommand(
        projectRoot,
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )
    const files = output.toString("utf8").split("\0").filter(Boolean).sort()
    for (const relativePath of files) {
        let stat
        try {
            stat = fs.lstatSync(path.resolve(projectRoot, relativePath))
        } catch (error) {
            throw new ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE",
                "Git 未跟踪项在快照期间消失",
                { cause: error },
            )
        }
        if (stat.isDirectory()) {
            throw new ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_SOURCE_UNSAFE",
                "Git 未跟踪目录或嵌套仓库不受支持",
            )
        }
    }
    const records = files.map(relativePath => stableFileRecord(projectRoot, relativePath))
    return { digest: sha256(records.join("\n")), count: files.length }
}

function captureGitSnapshot(projectRoot) {
    const digestCommand = args => sha256(runGitSnapshotCommand(projectRoot, args))
    return {
        head: runGitSnapshotCommand(projectRoot, ["rev-parse", "--verify", "HEAD"])
            .toString("utf8").trim(),
        tracked: digestCommand([
            "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--",
        ]),
        staged: digestCommand([
            "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--",
        ]),
        unstaged: digestCommand([
            "diff", "--binary", "--no-ext-diff", "--no-textconv", "--",
        ]),
        untracked: untrackedSnapshot(projectRoot),
    }
}

function archiveMetadataDigest(cdnRoot) {
    const cnRoot = path.join(cdnRoot, "cn")
    let archiveDirectories
    try {
        const archiveEntries = fs.readdirSync(cnRoot, { withFileTypes: true })
            .filter(entry => entry.name.startsWith("archive-"))
        if (archiveEntries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) {
            throw new ContentSyncSmokeError(
                "CONTENT_SYNC_SMOKE_CDN_INVALID",
                "CDN archive-* 项必须是普通目录",
            )
        }
        archiveDirectories = archiveEntries.map(entry => entry.name).sort()
    } catch (error) {
        if (error instanceof ContentSyncSmokeError) throw error
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_CDN_INVALID",
            "CDN 父目录下缺少可读取的 cn 目录",
            { cause: error },
        )
    }
    const metadata = []
    for (const directoryName of archiveDirectories) {
        const directoryPath = path.join(cnRoot, directoryName)
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            if (!entry.name.endsWith(".zip")) continue
            if (!entry.isFile()) {
                throw new ContentSyncSmokeError(
                    "CONTENT_SYNC_SMOKE_CDN_INVALID",
                    "CDN 原始 ZIP 必须是普通文件",
                )
            }
            const filePath = path.join(directoryPath, entry.name)
            const stat = fs.statSync(filePath, { bigint: true })
            if (!stat.isFile()) {
                throw new ContentSyncSmokeError(
                    "CONTENT_SYNC_SMOKE_CDN_INVALID",
                    "CDN 原始归档必须是普通文件",
                )
            }
            metadata.push([
                `${directoryName}/${entry.name}`,
                stat.dev.toString(),
                stat.ino.toString(),
                stat.mode.toString(),
                stat.size.toString(),
                stat.mtimeNs.toString(),
                stat.ctimeNs.toString(),
            ].join("\0"))
        }
    }
    metadata.sort()
    if (metadata.length === 0) {
        throw new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_CDN_INVALID",
            "CDN cn 目录中未找到原始 ZIP 归档",
        )
    }
    return { digest: sha256(metadata.join("\n")), count: metadata.length }
}

function seedSnapshot(projectRoot) {
    return directorySnapshot(path.join(projectRoot, "assets"), {
        predicate: relativePath => relativePath.toLowerCase().includes("seed"),
        sentinels: ["confirmed_seeds.json", "pending_seeds.json"],
    })
}

function databaseSnapshot(projectRoot) {
    return directorySnapshot(path.join(projectRoot, ".database"), {
        predicate: (_relativePath, entry) => entry.isFile(),
    })
}

function entityListsSnapshot(cdnRoot) {
    const entityRoot = path.join(cdnRoot, "cn", "EntityLists")
    return directorySnapshot(entityRoot, {
        predicate: (_relativePath, entry) => entry.isFile(),
        includeTimes: true,
    })
}

function captureEnvironment(paths) {
    const archives = archiveMetadataDigest(paths.cdnRoot)
    return {
        git: captureGitSnapshot(paths.projectRoot),
        seeds: seedSnapshot(paths.projectRoot),
        database: databaseSnapshot(paths.projectRoot),
        cdn: {
            archives,
            entityLists: entityListsSnapshot(paths.cdnRoot),
        },
    }
}

function readJson(projectRoot, relativePath) {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"))
}

function requireRawCharacterBaseline(release, bundled, tableName) {
    if (Object.keys(release).length !== 505 || !isDeepStrictEqual(release, bundled)) {
        baselineError(
            "CONTENT_SYNC_SMOKE_CHARACTER_BASELINE",
            `${tableName} 必须与 bundled 的 505 行基线一致`,
        )
    }
}

function loadContentRuntime(projectRoot) {
    require("ts-node").register({
        project: path.join(projectRoot, "tsconfig.json"),
        transpileOnly: true,
    })
    const { runContentSync } = require("../src/content/sync/engine")
    const { resolveContentPaths } = require("../src/content/paths")
    const { ContentObjectStore } = require("../src/content/sync/object-store")
    const { ContentRepository } = require("../src/content/runtime/content-repository")
    const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
    const { canonicalJsonBuffer } = require("../src/content/sync/canonical-json")
    return {
        ContentObjectStore,
        ContentRepository,
        resolveContentPaths,
        runContentSync,
        TABLE_SOURCES,
        canonicalJsonBuffer,
    }
}

async function validateSynchronizedContent({ paths, syncResult }) {
    const runtime = loadContentRuntime(paths.projectRoot)
    const contentPaths = runtime.resolveContentPaths({
        projectRoot: paths.projectRoot,
        env: paths.env,
    })
    const store = new runtime.ContentObjectStore(contentPaths)
    const snapshot = await store.readCurrentReleaseSnapshot()
    if (snapshot === null) {
        baselineError("CONTENT_SYNC_SMOKE_RELEASE_CLOSURE", "force sync 后缺少 current Release")
    }
    const catalog = snapshot.objects[snapshot.manifest.catalog.object]
    const repository = await runtime.ContentRepository.loadFromSnapshot(
        { projectRoot: paths.projectRoot, env: paths.env },
        snapshot,
    )
    validateReleaseClosure({
        syncResult,
        snapshot,
        repositoryInfo: repository.info(),
        catalog,
        registryNames: runtime.TABLE_SOURCES.map(definition => definition.tableName),
        expectedVersion: EXPECTED_VERSION,
        expectedTableCount: EXPECTED_TABLE_COUNT,
    })

    const bundledCharacter = readJson(paths.projectRoot, "assets/character.json")
    const releaseCharacter = repository.table("character.json")
    const bundledRawCharacter = readJson(paths.projectRoot, "assets/cdndata/character.json")
    const bundledRawCharacterText = readJson(
        paths.projectRoot,
        "assets/cdndata/character_text.json",
    )
    requireRawCharacterBaseline(
        repository.table("cdndata/character.json"),
        bundledRawCharacter,
        "cdndata/character.json",
    )
    requireRawCharacterBaseline(
        repository.table("cdndata/character_text.json"),
        bundledRawCharacterText,
        "cdndata/character_text.json",
    )
    const characterStats = validateCharacters({
        bundled: bundledCharacter,
        release: releaseCharacter,
        expectedSkillCounts: readJson(
            paths.projectRoot,
            "tools/fixtures/content-character/skill-count-1.4.54.json",
        ),
        expectedCount: 505,
        expectedUpgradeCount: 45,
        expectedTwoSkillCount: 12,
    })

    const releaseFeature = repository.table("cdndata/gacha_feature_content.json")
    const releaseFeatureDigest = `sha256:${sha256(runtime.canonicalJsonBuffer(releaseFeature))}`
    const gachaStats = validateGachas({
        bundledRaw: readJson(paths.projectRoot, "assets/cdndata/gacha.json"),
        releaseRaw: repository.table("cdndata/gacha.json"),
        bundledCampaigns: readJson(paths.projectRoot, "assets/gacha_campaign.json"),
        releaseCampaigns: repository.table("gacha_campaign.json"),
        bundledRuntime: readJson(paths.projectRoot, "assets/gacha.json"),
        releaseRuntime: repository.table("gacha.json"),
        releaseFeature,
        expectedGachaCount: 584,
        expectedCampaignCount: 145,
        expectedFeature: EXPECTED_FEATURE_COUNTS,
        releaseFeatureDigest,
        expectedFeatureDigest: EXPECTED_FEATURE_DIGEST,
    })

    const bundledShops = Object.fromEntries(SHOP_TABLE_NAMES.map(tableName => (
        [tableName, readJson(paths.projectRoot, `assets/${tableName}`)]
    )))
    const releaseShops = Object.fromEntries(SHOP_TABLE_NAMES.map(tableName => (
        [tableName, repository.table(tableName)]
    )))
    const shopStats = validateShops({
        bundled: bundledShops,
        release: releaseShops,
        rushEventIds: Array.from({ length: 7 }, (_, index) => 700011 + index),
        officialBossRows: readJson(paths.projectRoot, "assets/cdndata/boss_coin_shop.json"),
        officialOnlyStarGrainIds: ["9999"],
        expectedOfficialCounts: EXPECTED_OFFICIAL_SHOP_COUNTS,
    })
    return {
        version: EXPECTED_VERSION,
        tables: EXPECTED_TABLE_COUNT,
        characters: characterStats.characters,
        skillCountUpgrades: characterStats.skillCountUpgrades,
        twoSkillCharacters: characterStats.twoSkillCharacters,
        gachas: gachaStats.gachas,
        campaigns: gachaStats.campaigns,
        featureEntries: gachaStats.featureEntries,
        shops: Object.values(shopStats).reduce((sum, count) => sum + count, 0),
    }
}

function formatSuccessSummary(stats, archiveCount) {
    return [
        `版本 ${stats.version}`,
        `Registry ${stats.tables}`,
        `角色 ${stats.characters}`,
        `卡池 ${stats.gachas}`,
        `商店记录 ${stats.shops}`,
        `skill_count 3->6 ${stats.skillCountUpgrades ?? 45}`,
        `skill_count=2 ${stats.twoSkillCharacters ?? 12}`,
        `campaign ${stats.campaigns ?? 145}`,
        `feature ${stats.featureEntries ?? 2866}`,
        ...(archiveCount === undefined ? [] : [`归档元数据 ${archiveCount}`]),
        "来源未变",
    ].join("；")
}

function errorDiagnostic(error) {
    return {
        name: error instanceof Error ? error.name : typeof error,
        code: typeof error?.code === "string" ? error.code : undefined,
        message: error instanceof Error ? error.message : "未知错误",
    }
}

function combineAfterError(afterError, operationError) {
    if (operationError === undefined) return afterError
    const combined = afterError instanceof ContentSyncSmokeError
        ? new ContentSyncSmokeError(afterError.code, afterError.message, {
            cause: operationError,
        })
        : new ContentSyncSmokeError(
            "CONTENT_SYNC_SMOKE_SOURCE_UNSTABLE",
            "无法完成 smoke 后来源核对",
            { cause: operationError },
        )
    combined.diagnostics = {
        operation: errorDiagnostic(operationError),
        after: errorDiagnostic(afterError),
    }
    return combined
}

async function runContentSyncSmoke(options, dependencies = {}) {
    const paths = resolveSmokePaths(options)
    dependencies.beforePrepareContentRoot?.(paths)
    const contentSandbox = prepareContentRoot(paths)
    const capture = dependencies.captureEnvironment ?? captureEnvironment
    const runSync = dependencies.runSync ?? (syncOptions => (
        loadContentRuntime(paths.projectRoot).runContentSync(syncOptions)
    ))
    const validate = dependencies.validateSynchronizedContent ?? validateSynchronizedContent
    const before = await capture(paths)
    let stats
    let operationError
    try {
        dependencies.beforeRunSync?.({ paths, contentSandbox })
        verifyContentSandbox(paths, contentSandbox)
        const syncResult = await runSync({
            projectRoot: paths.projectRoot,
            env: paths.env,
            mode: "force",
        })
        stats = await validate({ paths, syncResult })
    } catch (error) {
        operationError = error
    }

    let after
    try {
        verifyContentSandbox(paths, contentSandbox)
        after = await capture(paths)
        assertEnvironmentUnchanged(before, after)
    } catch (error) {
        throw combineAfterError(error, operationError)
    }
    if (operationError !== undefined) throw operationError
    return formatSuccessSummary(stats, after.cdn?.archives?.count)
}

function sanitizeMessage(message, knownRoots) {
    const replacements = knownRoots
        .filter(Boolean)
        .sort((left, right) => right.value.length - left.value.length)
    let sanitized = String(message)
        .replace(/[\r\n\u2028\u2029]+/g, " ")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    for (const replacement of replacements) {
        sanitized = sanitized.split(replacement.value).join(replacement.label)
    }
    return sanitized
        .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/g, "$1<PATH>$1")
        .replace(
            /(^|[\s"'(=：:,，；;])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s:：,，;；"']+/gm,
            "$1<PATH>",
        )
}

async function runContentSyncSmokeCli(argv, dependencies = {}) {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, ".."))
    const stdout = dependencies.stdout ?? process.stdout
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    let parsed
    try {
        parsed = parseSmokeArguments(argv)
        const runSmoke = dependencies.runSmoke ?? runContentSyncSmoke
        const summary = await runSmoke({ projectRoot, ...parsed })
        stdout.write(`DONE [CONTENT_SYNC_SMOKE_OK]：${summary}\n`)
        setExitCode(0)
        return 0
    } catch (error) {
        const code = error instanceof ContentSyncSmokeError
            ? error.code
            : "CONTENT_SYNC_SMOKE_FAILED"
        const message = error instanceof ContentSyncSmokeError
            ? error.message
            : "内容 smoke 失败"
        stderr.write(`BLOCKED [${code}]：${sanitizeMessage(message, [
            { label: "<PROJECT_ROOT>", value: projectRoot },
            ...(parsed === undefined ? [] : [
                { label: "<CDN_ROOT>", value: path.resolve(parsed.cdnRoot) },
                { label: "<CONTENT_ROOT>", value: path.resolve(parsed.contentRoot) },
            ]),
        ])}\n`)
        const exitCode = code === "CONTENT_SYNC_SMOKE_ARGUMENTS" ? 2 : 1
        setExitCode(exitCode)
        return exitCode
    }
}

if (require.main === module) {
    void runContentSyncSmokeCli(process.argv.slice(2))
}

module.exports = {
    assertEnvironmentUnchanged,
    captureEnvironment,
    ContentSyncSmokeError,
    parseSmokeArguments,
    resolveSmokePaths,
    runGitSnapshotCommand,
    runContentSyncSmoke,
    runContentSyncSmokeCli,
    validateCharacters,
    validateGachas,
    validateReleaseClosure,
    validateShops,
}
