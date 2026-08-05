"use strict"

const assert = require("node:assert/strict")
const Fastify = require("fastify")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    checkLocalQuestAvailability,
    checkQuestAvailability,
} = require("../src/multi/quest-availability")
const { QuestCategory } = require("../src/lib/types/quest")

test("permanent quests are available without a bounded period", () => {
    const now = 1_725_000_000_000
    assert.deepEqual(
        checkQuestAvailability({ availableFromMs: null, availableUntilMs: null }, now),
        { available: true },
    )
})

test("an activity quest is available at two distinct times inside its local period", () => {
    const period = {
        availableFromMs: 1_725_000_000_000,
        availableUntilMs: 1_725_086_400_000,
    }
    assert.deepEqual(checkQuestAvailability(period, period.availableFromMs + 1), {
        available: true,
    })
    assert.deepEqual(checkQuestAvailability(period, period.availableUntilMs - 1), {
        available: true,
    })
})

test("a quest is unavailable before opening and after closing", () => {
    const period = {
        availableFromMs: 1_725_000_000_000,
        availableUntilMs: 1_725_086_400_000,
    }
    assert.deepEqual(checkQuestAvailability(period, period.availableFromMs - 1), {
        available: false,
        code: "QUEST_NOT_AVAILABLE",
    })
    assert.deepEqual(checkQuestAvailability(period, period.availableUntilMs + 1), {
        available: false,
        code: "QUEST_NOT_AVAILABLE",
    })
})

test("malformed periods and non-finite current time fail closed", () => {
    for (const [period, now] of [
        [{ availableFromMs: 20, availableUntilMs: 10 }, 15],
        [{ availableFromMs: Number.NaN, availableUntilMs: null }, 15],
        [{ availableFromMs: null, availableUntilMs: Number.POSITIVE_INFINITY }, 15],
        [{ availableFromMs: null, availableUntilMs: null }, Number.NaN],
    ]) {
        assert.deepEqual(checkQuestAvailability(period, now), {
            available: false,
            code: "QUEST_NOT_AVAILABLE",
        })
    }
})

test("availability accepts only a parsed period and local server time", () => {
    assert.equal(checkQuestAvailability.length, 2)
})

test("legacy bundled quests fail closed only for explicit activity categories", () => {
    const now = 1_725_000_000_000
    for (const category of [
        QuestCategory.MAIN,
        QuestCategory.BOSS_BATTLE,
        QuestCategory.CHARACTER,
        QuestCategory.EX,
        QuestCategory.DAILY_WEEK_EVENT,
        QuestCategory.DAILY_EXP_MANA_EVENT,
        QuestCategory.PRACTICE,
    ]) {
        assert.deepEqual(checkLocalQuestAvailability({}, category, now), { available: true })
    }
    for (const category of [
        QuestCategory.ADVENT_EVENT_SINGLE,
        QuestCategory.ADVENT_EVENT_MULTI,
        QuestCategory.STORY_EVENT_SINGLE,
        QuestCategory.RANKING_EVENT_SINGLE,
        QuestCategory.CHALLENGE_DUNGEON_EVENT,
        QuestCategory.WORLD_STORY_EVENT,
        QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
        QuestCategory.TOWER_DUNGEON_EVENT,
        QuestCategory.EXPERT_SINGLE_EVENT,
        QuestCategory.CARNIVAL_EVENT,
        QuestCategory.RAID_EVENT,
        QuestCategory.RUSH_EVENT,
        QuestCategory.SOLO_TIME_ATTACK_EVENT,
        QuestCategory.HARD_MULTI_EVENT,
        QuestCategory.SCORE_ATTACK_EVENT,
    ]) {
        assert.deepEqual(checkLocalQuestAvailability({}, category, now), {
            available: false,
            code: "QUEST_NOT_AVAILABLE",
        })
    }
    assert.deepEqual(checkLocalQuestAvailability({
        availableFromMs: now - 1,
        availableUntilMs: now + 1,
    }, QuestCategory.HARD_MULTI_EVENT, now), { available: true })
})

test("activity classification is declared with QuestCategory constants", () => {
    const source = fs.readFileSync(path.join(
        __dirname,
        "../src/multi/quest-availability.ts",
    ), "utf8")

    assert.match(source, /QuestCategory\.ADVENT_EVENT_SINGLE/)
    assert.match(source, /QuestCategory\.SCORE_ATTACK_EVENT/)
    assert.doesNotMatch(source, /EXPLICIT_ACTIVITY_CATEGORIES\s*=\s*new Set\(\[\s*\d/)
})

test("multi start rechecks local quest availability before entry writes", async t => {
    const assets = require("../src/lib/assets")
    const originalGetQuest = assets.getQuestFromCategorySync
    assets.getQuestFromCategorySync = () => ({
        name: "活动关卡",
        availableFromMs: 20,
        availableUntilMs: 30,
        rankPointReward: 0,
    })
    let entryWrites = 0
    const startEntry = require("../src/lib/quest/start-entry")
    const originalRunStart = startEntry.runStartEntryTransaction
    startEntry.runStartEntryTransaction = () => {
        entryWrites++
        throw new Error("entry transaction must not run")
    }
    t.after(() => {
        assets.getQuestFromCategorySync = originalGetQuest
        startEntry.runStartEntryTransaction = originalRunStart
    })

    const { createRoom, disbandRoom } = require("../src/multi/room/manager")
    const room = createRoom(101, 201, 1, 1, 701, 0, 401)
    t.after(() => disbandRoom(room.room_number))
    const { registerBattleRoutes } = require("../src/multi/http/battle")
    const fastify = Fastify()
    registerBattleRoutes(fastify, {
        resolvePlayerContext: async () => ({
            playerId: 201,
            player: { boostPoint: 0, bossBoostPoint: 0 },
        }),
        snapshotProvider: {
            getParticipant: viewerId => ({ nodeSessionId: "embedded", viewerId }),
        },
        questAvailability: {
            check: () => ({ available: false, code: "QUEST_NOT_AVAILABLE" }),
        },
    })
    await fastify.ready()
    t.after(async () => fastify.close())

    const response = await fastify.inject({
        method: "POST",
        url: "/start",
        payload: {
            viewer_id: 101,
            party_id: 1,
            quest_id: 701,
            category: 1,
            play_id: "availability-test",
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
            room_number: room.room_number,
            mate_player_ids: [],
        },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(entryWrites, 0)
})
