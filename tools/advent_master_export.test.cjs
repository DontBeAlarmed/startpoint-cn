const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    ADVENT_EVENT_LOGICAL,
    ADVENT_EVENT_QUEST_LOGICAL,
    findRuntimeUpload,
    hashedRelativePath,
    readAdventMaster,
    writeAdventExport,
} = require("./export_advent_master.cjs")

test("advent master export reads nested runtime advent event and quest fields", () => {
    const root = path.resolve(__dirname, "..")
    const store = findRuntimeUpload(root)

    assert.ok(store.endsWith(path.join("WorldFlipper", "dummy", "download", "production", "upload")))
    assert.equal(
        hashedRelativePath(ADVENT_EVENT_LOGICAL),
        path.join("c7", "428142e8bf6ca3dcd9445f67d0c882765710c7"),
    )
    assert.equal(
        hashedRelativePath(ADVENT_EVENT_QUEST_LOGICAL),
        path.join("6b", "ef338822b2c963eb40c67b3d43a3b3f911ad73"),
    )

    const master = readAdventMaster({ root })
    const event = master.events["200076"]
    const story = master.quests["200076001"]
    const soldier = master.quests["200076002"]
    const chapter2 = master.quests["200076007"]
    const empress = master.quests["200076009"]

    assert.equal(event.name, "\u6b7c\u706d\u8005\u8ba8\u4f10\u6218")
    assert.equal(event.startTime, "2025-06-26 12:00:00")
    assert.deepEqual(event.dropItemIdList, [10000070, 10000071])

    assert.equal(story.kind, "story")
    assert.equal(story.name, "\u5411\u661f\u661f\u8bb8\u613f")
    assert.equal(story.story.scenarioPath, "story/advent_event/boss_epuration/boss_epuration_event_001/scenario")
    assert.deepEqual(story.viewableNeedQuests, [])
    assert.deepEqual(story.selectableNeedQuests, [])

    assert.equal(soldier.kind, "battle")
    assert.equal(soldier.eventId, 200076)
    assert.equal(soldier.subId, 2)
    assert.equal(soldier.name, "\u6b69\u5175\u6b7c\u706d\u8005 ::quest_rank::")
    assert.deepEqual(soldier.viewableNeedQuests.map((quest) => quest.id), [200076001])
    assert.deepEqual(soldier.selectableNeedQuests, [])
    assert.equal(soldier.battle.availablePlayKind, 2)
    assert.equal(soldier.battle.staminaCost, 20)
    assert.equal(soldier.battle.scoreRewardGroupId, 11000483)
    assert.equal(soldier.battle.recommendedElement, 5)
    assert.deepEqual(soldier.battle.rankTimesMs, { b: 246000, a: 201000, s: 156000, ss: 120000 })
    assert.deepEqual(soldier.battle.rankItemCounts, { c: 1, b: 1, a: 2, s: 3, ss: 4 })
    assert.deepEqual(soldier.battle.rewards, { rankPoint: 1013, characterExp: 2435, mana: 2490, poolExp: 2435 })
    assert.deepEqual(chapter2.viewableNeedQuests.map((quest) => quest.id), [200076005, 200076006])

    assert.equal(empress.battle.availablePlayKind, 0)
    assert.equal(empress.battle.startableUseItemMode, 1)
    assert.equal(empress.battle.maxContinueCount, 0)
})

test("advent master export writes stable JSON artifacts", () => {
    const root = path.resolve(__dirname, "..")
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "advent-export-"))
    const master = readAdventMaster({ root })

    const written = writeAdventExport(master, outDir)

    assert.equal(path.basename(written.eventsPath), "advent_event.json")
    assert.equal(path.basename(written.questsPath), "advent_event_quest_full.json")
    assert.equal(JSON.parse(fs.readFileSync(written.eventsPath, "utf8"))["200076"].name, "\u6b7c\u706d\u8005\u8ba8\u4f10\u6218")
    assert.equal(JSON.parse(fs.readFileSync(written.questsPath, "utf8"))["200076009"].battle.maxContinueCount, 0)
})
