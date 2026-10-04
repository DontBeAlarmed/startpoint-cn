"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-activity-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const bundledActivity = require("../assets/event_activity.json")
const { installFrozenTestContentSnapshot } = require("./helpers/content-snapshot-fixture.cjs")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")

const { buildAdminActivityTimeline } = require("../src/lib/admin-activity")

const restoreBundledBaseline = installFrozenTestContentSnapshot({
    targetVersion: "1.4.54",
    tables: { "event_activity.json": bundledActivity },
}).restore

const MASTER_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function syntheticRows() {
    return [
        {
            eventId: 2,
            family: "raid_event",
            familyLabel: "战阵之宴",
            stringId: "raid_ended",
            name: "已结束条目",
            startTime: "2021-01-01 12:00:00",
            activeEndTime: "2021-01-10 11:59:59",
            closeEndTime: "2021-01-17 11:59:59",
        },
        {
            eventId: 1,
            family: "raid_event",
            familyLabel: "战阵之宴",
            stringId: "raid_live",
            name: "进行中条目",
            startTime: "2021-01-02 12:00:00",
            activeEndTime: "2021-02-10 11:59:59",
            closeEndTime: "2021-02-17 11:59:59",
        },
        {
            eventId: 1,
            family: "rush_event",
            familyLabel: "狂热激战",
            stringId: "rush_constant",
            name: "常驻条目",
            startTime: "2021-01-03 12:00:00",
        },
    ]
}

test("activity timeline aggregates the 13-family schedule from the fixed CN baseline", () => {
    const timeline = buildAdminActivityTimeline(new Date("2021-10-18T14:00:00.000Z"))

    assert.equal(timeline.scope, "event-quest")
    assert.equal(timeline.currentTime, "2021-10-18T14:00:00.000Z")
    assert.equal(timeline.timeline.length, 243, "13 族主表共 243 行日程")
    assert.equal(timeline.timeline.length, timeline.searchIndex.length, "搜索索引与日程一一对应")

    // 按 activeEndTime 升序；无活跃截止的常驻条目排在最后
    const ends = timeline.timeline.map(row => (
        row.activeEndTime === null ? Number.POSITIVE_INFINITY : Date.parse(row.activeEndTime)
    ))
    assert.deepEqual([...ends].sort((a, b) => a - b), ends, "timeline 必须按 activeEndTime 升序")
    assert.ok(ends[ends.length - 1] === Number.POSITIVE_INFINITY, "无活跃截止条目排在末尾")

    for (const row of timeline.timeline) {
        assert.match(row.startTime, /^\d{4}-\d{2}-\d{2}T/, "时间必须是绝对 ISO 时刻")
        assert.equal(typeof row.stringId, "string")
        assert.notEqual(row.stringId, "")
        assert.equal(typeof row.familyLabel, "string")
        assert.notEqual(row.familyLabel, "")
    }

    const blackThunder = timeline.timeline.find(row => row.family === "advent_event" && row.name === "黑雷的荒龙讨伐")
    assert(blackThunder, "应包含黑雷的荒龙讨伐")
    // 主表墙钟在 +480 游戏日历下换算为绝对 UTC（与卡池千里眼同口径）
    assert.equal(blackThunder.startTime, "2019-12-26T04:00:00.000Z")
    assert.equal(blackThunder.activeEndTime, "2020-01-10T03:59:59.000Z")
    assert.equal(blackThunder.closeEndTime, "2020-01-17T03:59:59.000Z")

    const firstRaid = timeline.timeline.find(row => row.family === "raid_event" && row.eventId === 1)
    assert(firstRaid, "应包含战阵之宴首期")
    assert.equal(firstRaid.startTime, "2023-09-07T04:00:00.000Z")
    assert.equal(firstRaid.closeEndTime, "2023-10-06T03:59:59.000Z")
})

test("activity search index covers name, stringId, family aliases, and notice aliases", () => {
    const timeline = buildAdminActivityTimeline(new Date("2021-10-18T14:00:00.000Z"))

    const thunder = timeline.searchIndex.find(row => row.name === "黑雷的荒龙讨伐")
    assert(thunder, "搜索索引应包含黑雷的荒龙讨伐")
    assert.equal(thunder.family, "advent_event")
    assert.equal(thunder.familyLabel, "降临讨伐")
    assert.deepEqual(thunder.aliases, ["降临讨伐"])

    const rerun = timeline.searchIndex.find(row => row.name === "雷废龙讨伐复刻")
    assert(rerun, "搜索索引应包含雷废龙讨伐复刻")
    assert.ok(rerun.aliases.includes("黑雷的荒龙"), "公告别名应并入搜索索引")

    const raid = timeline.searchIndex.find(row => row.family === "raid_event")
    assert.ok(raid.aliases.includes("团本"), "family 全量别名应并入搜索索引")

    const constant = timeline.searchIndex.find(row => row.stringId === "rush_constant")
    assert.equal(constant, undefined, "基线索引不应包含合成条目")
})

test("activity timeline ISO instants follow the game calendar offset and cache per offset", () => {
    let tableReads = 0
    const { restore: restoreProbe } = installFrozenTestContentSnapshot({
        targetVersion: "cache-test",
        onTableRead: () => { tableReads += 1 },
        tables: { "event_activity.json": syntheticRows() },
    })

    try {
        const first480 = buildAdminActivityTimeline(new Date("2021-01-05T00:00:00.000Z"))
        const second480 = buildAdminActivityTimeline(new Date("2021-02-05T00:00:00.000Z"))
        assert.equal(tableReads, 1, "同一个固定 Repository 的同一偏移只应构建一次静态活动日程")
        assert.notStrictEqual(first480.currentTime, second480.currentTime)

        const timeline540 = buildAdminActivityTimeline(
            new Date("2021-01-05T00:00:00.000Z"),
            createGameCalendarPolicy(540),
        )
        const live480 = first480.timeline.find(row => row.stringId === "raid_live")
        const live540 = timeline540.timeline.find(row => row.stringId === "raid_live")
        assert(live480 && live540)
        assert.equal(
            live540.startTime,
            new Date(Date.parse(live480.startTime) - 3_600_000).toISOString(),
            "同一主表时刻在 +540 下必须对应提前一小时的绝对 ISO 时刻",
        )
        assert.notStrictEqual(timeline540.timeline, first480.timeline, "缓存必须按日历偏移区分")
        assert.equal(tableReads, 2, "每个日历偏移各构建一次")
        const reread540 = buildAdminActivityTimeline(
            new Date("2021-01-05T00:00:00.000Z"),
            createGameCalendarPolicy(540),
        )
        assert.equal(tableReads, 2, "命中缓存时不得再次读取内容表")
        assert.equal(
            reread540.timeline.find(row => row.stringId === "raid_live").startTime,
            live540.startTime,
            "+540 重复请求必须命中 +540 的缓存",
        )
    } finally {
        restoreProbe()
    }
})

test("activity timeline keeps rows without an active end after dated rows deterministically", () => {
    const { restore } = installFrozenTestContentSnapshot({
        targetVersion: "sort-test",
        tables: { "event_activity.json": syntheticRows() },
    })
    try {
        const timeline = buildAdminActivityTimeline(new Date("2021-01-05T00:00:00.000Z"))
        assert.deepEqual(
            timeline.timeline.map(row => row.stringId),
            ["raid_ended", "raid_live", "rush_constant"],
            "先按活跃截止升序，随后是无截止的开始时间序，常驻条目最后",
        )
        assert.equal(timeline.timeline[2].activeEndTime, null)
        assert.equal(timeline.timeline[2].closeEndTime, null)
    } finally {
        restore()
    }
})

test("GET /clairvoyance/activity returns the baseline header fields beside the gacha route", async t => {
    const serverRoutes = require("../src/routes/web_api/server").default
    const data = require("../src/data")
    data.initializeDatabase()

    // 两个千里眼路由共用同一个 content 快照：活动表 + 卡池目录全套
    const bundledGachas = require("../assets/gacha.json")
    const bundledGachaPools = require("../assets/gacha_pool.json")
    const { restore: restoreFull } = installFrozenTestContentSnapshot({
        targetVersion: "1.4.54",
        tables: {
            "event_activity.json": bundledActivity,
            "gacha.json": bundledGachas,
            "gacha_pool.json": bundledGachaPools,
            "character.json": require("../assets/character.json"),
            "cdndata/character_text.json": require("../assets/cdndata/character_text.json"),
            "gacha_campaign_definitions.json": require("../assets/gacha_campaign_definitions.json"),
            "stars_gacha_campaign.json": require("../assets/stars_gacha_campaign.json"),
            "gacha_exchange_rate.json": require("../assets/gacha_exchange_rate.json"),
            "equipment_lookup.json": require("../assets/equipment_lookup.json"),
            "item_lookup.json": require("../assets/item_lookup.json"),
            "equipment_gacha_movie_probability.json": require("../assets/equipment_gacha_movie_probability.json"),
        },
    })
    t.after(() => restoreFull())

    const app = Fastify({ logger: false })
    t.after(async () => {
        await app.close()
        data.closeDatabase()
        fs.rmSync(databaseDirectory, { recursive: true, force: true })
    })
    await app.register(serverRoutes, {
        runtimeConfig: {
            http: { host: "127.0.0.1", port: 9102 },
            httpDisplayHost: "127.0.0.1",
            assetProvider: { mode: "client-owned" },
            gameCalendarUtcOffsetMinutes: 480,
        },
    })
    await app.ready()

    const response = await app.inject({ method: "GET", url: "/clairvoyance/activity" })
    assert.equal(response.statusCode, 200, response.payload)
    const payload = JSON.parse(response.payload)
    assert.equal(payload.scope, "event-quest")
    assert.equal(payload.baseline, "fixed-cn-final")
    assert.match(payload.cdnVersion, /^\d+\.\d+\.\d+$/)
    assert.equal(payload.timeline.length, 243)
    assert.ok(payload.searchIndex.length > 0)

    const gachaResponse = await app.inject({ method: "GET", url: "/clairvoyance/gacha" })
    assert.equal(gachaResponse.statusCode, 200)
    const gachaPayload = JSON.parse(gachaResponse.payload)
    assert.equal(gachaPayload.scope, "short-up-character-gacha")
    assert.equal(gachaPayload.cdnVersion, payload.cdnVersion, "两个千里眼路由共享同一 CDN 基线")
})

test.after(() => {
    restoreBundledBaseline()
})
