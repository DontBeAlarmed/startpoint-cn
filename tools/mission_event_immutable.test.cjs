"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { characterExpCaps } = require("../src/lib/character")
const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const {
    EventSafeComputer,
    getEventCurrentStateStaticIndex,
} = require("../src/lib/mission/computer-event-safe")
const {
    getEventRuleCatalog,
    selectEventRules,
} = require("../src/lib/mission/event-rule-catalog")
const { deriveEventCurrentState } = require("../src/lib/mission/event-static-state")

const catalog = getMissionCatalog()
const requirementRegistry = getMissionFactRequirementRegistry(catalog)
const finishedChallengeQuest = Object.freeze({
    questId: 1002,
    finished: true,
    clearRank: 1,
    bestElapsedTimeMs: undefined,
    leaderCharacterId: undefined,
    multiClearCount: undefined,
})

function buildAggregateContext() {
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => Object.freeze({ id: 77 }))
        .register("questProgress", () => ({ 13: [finishedChallengeQuest] }))
        .register("categoryMissionProgress", () => new Map())
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime: new Date("2020-05-01T04:00:00.000Z"),
        catalog,
        requirementRegistry,
        candidates: [{ category: 3, missionId: 1454 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    return EventSafeComputer.buildContextFromSession(session, 3, [1454])
}

function attemptArrayPush(values, value) {
    const original = [...values]
    let error
    try {
        values.push(value)
    } catch (caught) {
        error = caught
    }
    const after = [...values]
    if (error === undefined) values.splice(0, values.length, ...original)
    return { after, error, original }
}

function attemptPropertyWrite(object, key, value) {
    const original = object[key]
    let error
    try {
        object[key] = value
    } catch (caught) {
        error = caught
    }
    const after = object[key]
    if (error === undefined) object[key] = original
    return { after, error, original }
}

function assertMapMutatorsRejected(map, label) {
    const entries = [...map]
    const [firstKey, firstValue] = entries[0]
    const errors = []
    for (const invoke of [
        () => map.set(firstKey, firstValue),
        () => map.delete(Symbol("missing")),
        () => map.clear(),
    ]) {
        try {
            invoke()
            errors.push(undefined)
        } catch (error) {
            errors.push(error)
        }
    }
    if (errors.some(error => error === undefined)) {
        map.clear()
        for (const [key, value] of entries) map.set(key, value)
    }
    assert.equal(errors.every(error => error instanceof TypeError), true, label)
    assert.deepEqual([...map], entries, label)
}

function assertSetMutatorsRejected(set, label) {
    const values = [...set]
    const firstValue = values[0]
    const errors = []
    for (const invoke of [
        () => set.add(firstValue),
        () => set.delete(Symbol("missing")),
        () => set.clear(),
    ]) {
        try {
            invoke()
            errors.push(undefined)
        } catch (error) {
            errors.push(error)
        }
    }
    if (errors.some(error => error === undefined)) {
        set.clear()
        for (const value of values) set.add(value)
    }
    assert.equal(errors.every(error => error instanceof TypeError), true, label)
    assert.deepEqual([...set], values, label)
}

test("Event aggregate rule pollution cannot affect the same or a later Session", () => {
    const firstContext = buildAggregateContext()
    const rule = firstContext.eventRules.get(1454)
    assert.equal(EventSafeComputer.compute(1454, firstContext, 0), 1)
    const originalLength = rule.missionIds.length
    let error
    try {
        rule.missionIds.push(1448)
    } catch (caught) {
        error = caught
    }
    const firstAfter = EventSafeComputer.compute(1454, firstContext, 0)
    const laterContext = buildAggregateContext()
    const laterAfter = EventSafeComputer.compute(1454, laterContext, 0)
    if (error === undefined) rule.missionIds.length = originalLength

    assert.deepEqual({
        mutationRejected: error instanceof TypeError,
        firstAfter,
        laterAfter,
    }, {
        mutationRejected: true,
        firstAfter: 1,
        laterAfter: 1,
    })
})

test("Event Catalog rules deeply reject nested object and array mutation", () => {
    const allRules = getEventRuleCatalog(catalog)
    const selectedRules = selectEventRules(catalog, [1454])
    assert.equal(allRules.set, undefined)
    assert.equal(allRules.delete, undefined)
    assert.equal(allRules.clear, undefined)
    assert.equal(selectedRules.set, undefined)
    assert.equal(selectedRules.delete, undefined)
    assert.equal(selectedRules.clear, undefined)

    let checkedArrays = 0
    let checkedCurrentState = 0
    for (const [missionId, rule] of allRules) {
        assert.equal(Object.isFrozen(rule), true, String(missionId))
        for (const key of ["missionIds", "questIds", "categories"]) {
            const values = rule[key]
            if (!Array.isArray(values)) continue
            checkedArrays++
            const outcome = attemptArrayPush(values, 999999999)
            assert.equal(outcome.error instanceof TypeError, true, `${missionId}.${key}`)
            assert.deepEqual(outcome.after, outcome.original, `${missionId}.${key}`)
        }
        if (rule.kind !== "currentState") continue
        checkedCurrentState++
        assert.equal(Object.isFrozen(rule.rule), true, `${missionId}.rule`)
        const fact = attemptPropertyWrite(rule.rule, "fact", "polluted")
        assert.equal(fact.error instanceof TypeError, true, `${missionId}.rule.fact`)
        assert.equal(fact.after, fact.original, `${missionId}.rule.fact`)
        const targets = attemptArrayPush(rule.rule.targets, 999999999)
        assert.equal(targets.error instanceof TypeError, true, `${missionId}.rule.targets`)
        assert.deepEqual(targets.after, targets.original, `${missionId}.rule.targets`)
    }
    assert.equal(checkedArrays > 0, true)
    assert.equal(checkedCurrentState, 15)
})

test("Event current-state static indexes isolate sources and reject Map Set and nested mutation", () => {
    const index = getEventCurrentStateStaticIndex(catalog)
    assert.equal(Object.isFrozen(index), true)
    const maps = [
        index.characters,
        index.characterStoryQuestIds,
        index.equipmentMaxLevels,
        index.mainQuestIdsByChapter,
        index.manaNodeIdsByCharacter,
    ]
    for (const map of maps) {
        assert.notEqual(map, null)
        assertMapMutatorsRejected(map, "static Map")
    }
    assert.notEqual(index.abilitySoulItemIds, null)
    assertSetMutatorsRejected(index.abilitySoulItemIds, "ability soul Set")

    const [characterId, characterFact] = index.characters.entries().next().value
    const sourceThresholds = characterExpCaps[characterFact.rarity]
    const sourceBefore = [...sourceThresholds]
    assert.notStrictEqual(characterFact.experienceThresholds, sourceThresholds)
    assert.equal(Object.isFrozen(characterFact), true)
    assert.equal(Object.isFrozen(characterFact.experienceThresholds), true)
    const rarity = attemptPropertyWrite(characterFact, "rarity", 99)
    assert.equal(rarity.error instanceof TypeError, true)
    assert.equal(rarity.after, rarity.original)
    const thresholds = attemptArrayPush(characterFact.experienceThresholds, 999999999)
    assert.equal(thresholds.error instanceof TypeError, true)
    assert.deepEqual(thresholds.after, thresholds.original)
    assert.deepEqual(characterExpCaps[characterFact.rarity], sourceBefore)

    const storyEntry = [...index.characterStoryQuestIds].find(([, ids]) => ids.length > 0)
    const storyIds = attemptArrayPush(storyEntry[1], 999999999)
    assert.equal(storyIds.error instanceof TypeError, true)
    assert.deepEqual(storyIds.after, storyIds.original)
    const chapterEntry = [...index.mainQuestIdsByChapter].find(([, ids]) => ids.length > 0)
    const chapterIds = attemptArrayPush(chapterEntry[1], 999999999)
    assert.equal(chapterIds.error instanceof TypeError, true)
    assert.deepEqual(chapterIds.after, chapterIds.original)

    const manaEntry = [...index.manaNodeIdsByCharacter].find(([, ids]) => ids.size > 0)
    const manaIds = manaEntry[1]
    assertSetMutatorsRejected(manaIds, "mana node Set")
    const invalidNodeId = 999999999
    let manaError
    try {
        manaIds.add(invalidNodeId)
    } catch (caught) {
        manaError = caught
    }
    const manaPolluted = manaIds.has(invalidNodeId)
    if (manaError === undefined) manaIds.delete(invalidNodeId)
    assert.deepEqual({
        mutationRejected: manaError instanceof TypeError,
        manaPolluted,
    }, {
        mutationRejected: true,
        manaPolluted: false,
    })

    const exp = characterFact.experienceThresholds.at(-1)
    const derive = staticIndex => deriveEventCurrentState(
        { characters: { [characterId]: { exp, overLimitStep: 0 } } },
        staticIndex,
        [1305],
        missionId => {
            const rule = getEventRuleCatalog(catalog).get(missionId)
            return rule?.kind === "currentState" ? rule.rule : undefined
        },
    ).maxCharacterLevel
    const before = derive(index)
    const laterIndex = getEventCurrentStateStaticIndex(catalog)
    assert.strictEqual(laterIndex, index)
    assert.equal(derive(laterIndex), before)
})
