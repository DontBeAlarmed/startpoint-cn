"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertEventFamilies
let EVENT_FAMILY_SOURCE_PATHS
let EVENT_FAMILY_TABLES
try {
    ({
        convertEventFamilies,
        EVENT_FAMILY_SOURCE_PATHS,
        EVENT_FAMILY_TABLES,
    } = require("../src/content/converters/event-family"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function row(key, fields) {
    return { key, text: encodeCsv(fields.map(String)) }
}

const RAID_PATH = "master/quest/event/raid_event.orderedmap"
const STORY_PATH = "master/quest/event/story_event.orderedmap"
const TOWER_PATH = "master/quest/event/tower_dungeon_event.orderedmap"

// Column layouts follow ACTIVITY_SPECS from the operations-schedule review.
function raidRow(overrides = {}) {
    const fields = Array(25).fill("")
    fields[0] = "raid_event_01"
    fields[1] = "团本活动 战阵之宴"
    fields[3] = "quest/event/banner/raid_event/raid_event_banner_01_001"
    fields[22] = "2023-09-07 12:00:00"
    fields[23] = "2023-09-28 11:59:59"
    fields[24] = "2023-10-06 11:59:59"
    return row("1", Object.entries(overrides).reduce((acc, [index, value]) => {
        acc[index] = value
        return acc
    }, fields))
}

function towerRow() {
    const fields = Array(14).fill("")
    fields[0] = "tower_dungeon_01"
    fields[1] = "幽玄域"
    fields[11] = "2022-05-12 12:00:00"
    fields[12] = "2026-05-12 04:59:59"
    fields[13] = "2026-05-12 04:59:59"
    return row("1", fields)
}

function storyRow() {
    const fields = Array(19).fill("")
    fields[0] = "xm20_white_tiger"
    fields[2] = "白与圣诞节"
    fields[16] = "2020-12-14 12:00:00"
    fields[17] = "2020-12-28 11:59:59"
    fields[18] = "2020-12-28 11:59:59"
    return row("7", fields)
}

function fixture(overrides = new Map()) {
    const requested = []
    const sources = new Map([
        [RAID_PATH, [raidRow()]],
        [STORY_PATH, [storyRow()]],
        [TOWER_PATH, [towerRow()]],
        ...overrides,
    ])
    return {
        requested,
        reader: {
            async read(logicalPath) {
                requested.push(logicalPath)
                if (sources.has(logicalPath)) return sources.get(logicalPath)
                // 未覆盖的族默认空表：转换器仍必须读取全部 13 张声明的来源
                if (EVENT_FAMILY_SOURCE_PATHS.includes(logicalPath)) return []
                throw new Error(`missing fixture ${logicalPath}`)
            },
        },
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("event family converter emits the merged activity catalog from authoritative rows", async () => {
    assert.equal(typeof convertEventFamilies, "function", "应导出 convertEventFamilies")
    const source = fixture()
    const output = await convertEventFamilies(source.reader)

    assert.deepEqual(Object.keys(output), ["event_activity.json"])
    const rows = output["event_activity.json"]
    assert.equal(rows.length, 3, "三族各提供一行日程")
    assert.deepEqual(
        rows.map(row => row.family),
        ["story_event", "tower_dungeon_event", "raid_event"],
        "输出按 startTime 升序排列",
    )

    const raid = rows.find(row => row.family === "raid_event")
    assert.deepEqual(raid, {
        eventId: 1,
        family: "raid_event",
        familyLabel: "战阵之宴",
        stringId: "raid_event_01",
        name: "团本活动 战阵之宴",
        startTime: "2023-09-07 12:00:00",
        activeEndTime: "2023-09-28 11:59:59",
        closeEndTime: "2023-10-06 11:59:59",
        bannerPath: "quest/event/banner/raid_event/raid_event_banner_01_001",
    })
    assertDeepFrozen(output)
})

test("event family converter keeps (None) ends and empty banners optional", async () => {
    const rows = Array(25).fill("")
    rows[0] = "raid_event_07"
    rows[1] = "活动名"
    rows[22] = "2025-06-26 12:00:00"
    rows[23] = "(None)"
    rows[24] = "(None)"
    rows[3] = ""
    const source = fixture(new Map([
        [RAID_PATH, [row("7", rows)]],
        [STORY_PATH, []],
        [TOWER_PATH, []],
    ]))
    const output = await convertEventFamilies(source.reader)
    assert.deepEqual(output["event_activity.json"][0], {
        eventId: 7,
        family: "raid_event",
        familyLabel: "战阵之宴",
        stringId: "raid_event_07",
        name: "活动名",
        startTime: "2025-06-26 12:00:00",
    })
})

test("event family converter is fail-closed on malformed rows", async () => {
    const cases = [
        ["duplicate key", new Map([[RAID_PATH, [raidRow(), raidRow()]]])],
        ["short row", new Map([[RAID_PATH, [row("1", Array(24).fill(""))]]])],
        ["non-integer key", new Map([[RAID_PATH, [row("x1", Array(25).fill(""))]]])],
        ["invalid start", new Map([[RAID_PATH, [raidRow({ 22: "2023-09-07" })]]])],
        ["inverted window", new Map([[RAID_PATH, [raidRow({ 23: "2023-09-01 11:59:59" })]]])],
        ["close before active end", new Map([[RAID_PATH, [raidRow({ 24: "2023-09-20 11:59:59" })]]])],
        ["empty stringId", new Map([[RAID_PATH, [raidRow({ 0: "" })]]])],
        ["placeholder name", new Map([[RAID_PATH, [raidRow({ 1: "(None)" })]]])],
    ]
    for (const [name, overrides] of cases) {
        await assert.rejects(
            convertEventFamilies(fixture(overrides).reader),
            error => error?.message.startsWith("invalid event family content:"),
            `应拒绝 ${name}`,
        )
    }
})

test("event family converter reads exactly the 13 declared family tables", async () => {
    assert.equal(EVENT_FAMILY_SOURCE_PATHS.length, 13)
    assert.equal(new Set(EVENT_FAMILY_SOURCE_PATHS).size, 13)
    assert.equal(Object.keys(EVENT_FAMILY_TABLES).length, 13)
    const source = fixture()
    await convertEventFamilies(source.reader)
    assert.deepEqual(
        [...source.requested].sort(),
        [...EVENT_FAMILY_SOURCE_PATHS].sort(),
        "转换器只读取注册表声明的来源",
    )
})
