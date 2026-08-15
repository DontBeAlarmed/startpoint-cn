"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    EMPTY_BATTLE_COUNTERS,
    EMPTY_DEGREE_BATTLE_STATS,
    allFacts,
    buildDegreeRuleCatalog,
    bundledMissionContentRepository,
    character,
    clone,
    createSession,
    getMissionCatalog,
    player,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")
const { cloneAndFreeze } = require("../src/lib/mission/degree-immutable")

test("Degree immutable clone supports only primitive plain-object and array graphs", () => {
    const source = { nested: [{ count: 1 }] }
    const cloned = cloneAndFreeze(source)
    assert.notEqual(cloned, source)
    assert.notEqual(cloned.nested, source.nested)
    assert.equal(Object.isFrozen(cloned.nested[0]), true)
    assert.throws(() => { cloned.nested[0].count = 2 }, TypeError)

    const accessor = {}
    Object.defineProperty(accessor, "secret", { get: () => 1, enumerable: true })
    const exotic = Object.create({ inherited: true })
    exotic.value = 1
    const circular = {}
    circular.self = circular
    for (const [value, path] of [
        [{ when: new Date(0) }, "$.when"],
        [{ nested: accessor }, "$.nested.secret"],
        [{ nested: exotic }, "$.nested"],
        [{ nested: circular }, "$.nested.self"],
        [{ nested: () => 1 }, "$.nested"],
    ]) {
        assert.throws(
            () => cloneAndFreeze(value),
            error => error instanceof TypeError && error.message.includes(path),
            path,
        )
    }
})

test("Degree rule catalogs and contexts are runtime immutable and isolate Session facts", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const missionIds = [1000, 111001, 1111001, 9000, 12000, 13000, 46000, 11010,
        57010, 58000, 68000, 61040, 62330, 41000, 70000, 43000, 16000]
    const sourceFacts = allFacts({
        player: { ...player(), totalDashes: 3 },
        characters: {
            111001: character({
                exp: 379988,
                bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
            }),
        },
        characterManaNodes: { 111001: [101, 102] },
        missionBattleCounters: { ...EMPTY_BATTLE_COUNTERS, singleScoreMax: 77 },
        degreeBattleStats: { ...EMPTY_DEGREE_BATTLE_STATS, feverCount: 9 },
        questProgress: { 2: [{ questId: 1003004, finished: true }] },
        shopPurchases: { 1: 2 },
        collectedItems: { 100000: 4, 70014: 5 },
        equipment: { 101001: { level: 5, enhancementLevel: 0, protection: false, stack: 0 } },
    })
    const context = DegreeComputer.buildContextFromSession(
        createSession(catalog, missionIds, sourceFacts), 5, missionIds,
    )
    assert.equal(context.degreeRules.set, undefined)
    assert.equal(context.degreeRules.delete, undefined)
    assert.equal(context.degreeStats.characterLevels.set, undefined)
    assert.equal(context.degreeStats.bondedCharacterIds.add, undefined)
    assert.equal(context.degreeStats.episodeCompletedChapters.add, undefined)
    assert.equal(context.degreeStats.bossBattleSuperQuestByMission.set, undefined)
    assert.equal(context.degreeStats.finishedQuestIdsBySection[2].add, undefined)
    assert.throws(() => { context.player.totalDashes = 99 }, TypeError)
    assert.throws(() => { context.battleCounters.singleScoreMax = 99 }, TypeError)
    assert.throws(() => { context.degreeStats.degreeBattleStats.feverCount = 99 }, TypeError)
    assert.throws(() => { context.degreeStats.collectedItemTotals["70014"] = 99 }, TypeError)
    assert.throws(() => { context.degreeStats = undefined }, TypeError)
    assert.notEqual(context.player, sourceFacts.player)
    assert.notEqual(context.battleCounters, sourceFacts.missionBattleCounters)
    assert.notEqual(context.degreeStats.degreeBattleStats, sourceFacts.degreeBattleStats)
    assert.notEqual(context.degreeStats.collectedItemTotals, sourceFacts.collectedItems)
    assert.equal(sourceFacts.player.totalDashes, 3)
    assert.equal(sourceFacts.missionBattleCounters.singleScoreMax, 77)
    assert.equal(sourceFacts.degreeBattleStats.feverCount, 9)
    assert.equal(sourceFacts.collectedItems[70014], 5)
})

test("Degree rule catalogs do not expose mutable Content or cross-Session rule state", () => {
    const sourceManaBoard = clone(bundledMissionContentRepository.table("mana_board.json"))
    const catalog = getMissionCatalog(repositoryWith({
        "mana_board.json": sourceManaBoard,
    }, "isolated-degree-content"))
    const first = buildDegreeRuleCatalog(catalog, [1111001])
    const second = buildDegreeRuleCatalog(catalog, [1111001])
    const rule = first.rules.get(1111001)
    const board = first.tables.manaBoard[String(rule.characterId)]["2"]
    const boardRows = Object.values(board)[0]
    assert.equal(first.rules.set, undefined)
    assert.equal(first.rules.delete, undefined)
    assert.equal(Object.isFrozen(rule), true)
    assert.throws(() => { rule.pattern = "polluted" }, TypeError)
    assert.throws(() => { rule.facts.push({ kind: "player" }) }, TypeError)
    assert.notEqual(first.tables.manaBoard, sourceManaBoard)
    assert.equal(Object.isFrozen(first.tables.manaBoard), true)
    assert.equal(Object.isFrozen(boardRows), true)
    assert.throws(() => { boardRows[0][0] = 999999 }, TypeError)
    assert.notEqual(first.rules, second.rules)
    assert.equal(second.rules.get(1111001).pattern, "degree_favor_fire_dragon_2")
    const bundled = buildDegreeRuleCatalog(getMissionCatalog(bundledMissionContentRepository), [1111001])
    assert.notEqual(bundled.tables.manaBoard, bundledMissionContentRepository.table("mana_board.json"))
    assert.equal(Object.isFrozen(bundled.tables.manaBoard), true)
})
