const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

let validation = {}
let activeQuestService = {}
try {
    validation = require("../src/lib/quest/multi-battle-validation")
    activeQuestService = require("../src/lib/quest/active-quest-service")
} catch {
    // RED: the lifecycle contract is introduced by this change.
}

const { validateMultiFinishRequest, validateMultiStartRequest } = validation
const { runContinueActiveQuestTransaction } = activeQuestService

test("multi start requires a room member and matching room quest", () => {
    assert.equal(typeof validateMultiStartRequest, "function")
    const base = {
        viewerId: 101,
        partyId: 1,
        questId: 501,
        category: 2,
        playId: "play-1",
        useBoostPoint: false,
        useBossBoostPoint: false,
        isAutoStartMode: false,
        isRoomMember: true,
        roomCategory: 2,
        roomQuestId: 501,
    }
    assert.deepEqual(validateMultiStartRequest(base), { ok: true })
    assert.equal(validateMultiStartRequest({ ...base, isRoomMember: false }).ok, false)
    assert.equal(validateMultiStartRequest({ ...base, roomQuestId: 999 }).ok, false)
    assert.equal(validateMultiStartRequest({ ...base, useBoostPoint: 1 }).ok, false)
    assert.equal(validateMultiStartRequest({ ...base, playId: "" }).ok, false)
})

test("multi finish rejects identity mismatches and reward-inflating values", () => {
    assert.equal(typeof validateMultiFinishRequest, "function")
    const activeQuest = {
        playId: "play-1",
        questId: 501,
        category: 2,
        isMulti: true,
        continueCount: 1,
        useBoostPoint: true,
        useBossBoostPoint: false,
    }
    const base = {
        play_id: "play-1",
        quest_id: 501,
        category: 2,
        elapsed_time_ms: 10_000,
        is_accomplished: true,
        add_mana: 5,
        score: 100,
        continue_count: 1,
        statistics: { party: { characters: [], unison_characters: [] } },
    }
    assert.deepEqual(
        validateMultiFinishRequest(base, activeQuest, { boostPoint: 1, bossBoostPoint: 0 }),
        { ok: true, elapsedTimeMs: 10_000, addMana: 5, score: 100, statistics: base.statistics },
    )
    for (const body of [
        { ...base, play_id: "other" },
        { ...base, quest_id: 999 },
        { ...base, elapsed_time_ms: 0 },
        { ...base, elapsed_time_ms: -1 },
        { ...base, add_mana: -1 },
        { ...base, score: Number.NaN },
        { ...base, is_accomplished: 1 },
        { ...base, continue_count: 0 },
        { ...base, statistics: null },
        { ...base, statistics: {} },
    ]) {
        assert.equal(validateMultiFinishRequest(body, activeQuest, { boostPoint: 1, bossBoostPoint: 0 }).ok, false)
    }
    assert.equal(
        validateMultiFinishRequest(base, activeQuest, { boostPoint: 0, bossBoostPoint: 0 }).ok,
        false,
    )
})

test("multi continue commits storage before publishing the new memory count", () => {
    assert.equal(typeof runContinueActiveQuestTransaction, "function")
    const memoryQuest = {
        playId: "play-1",
        questId: 501,
        category: 2,
        isMulti: true,
        continueCount: 0,
    }
    let storedQuest = { ...memoryQuest }
    let failCommit = true
    const dependencies = {
        transaction(operation) {
            const snapshot = { ...storedQuest }
            try {
                const result = operation()
                if (failCommit) throw new Error("commit failed")
                return result
            } catch (error) {
                storedQuest = snapshot
                throw error
            }
        },
        getStoredActiveQuest: () => ({ ...storedQuest }),
        updateStoredContinueCount(_playerId, count) { storedQuest.continueCount = count },
    }
    assert.throws(
        () => runContinueActiveQuestTransaction(7, memoryQuest, {
            playId: "play-1", questId: 501, category: 2,
        }, dependencies),
        /commit failed/,
    )
    assert.equal(memoryQuest.continueCount, 0)
    assert.equal(storedQuest.continueCount, 0)

    failCommit = false
    assert.equal(runContinueActiveQuestTransaction(7, memoryQuest, {
        playId: "wrong", questId: 501, category: 2,
    }, dependencies), null)
    assert.equal(memoryQuest.continueCount, 0)

    assert.equal(runContinueActiveQuestTransaction(7, memoryQuest, {
        playId: "play-1", questId: 501, category: 2,
    }, dependencies), 1)
    assert.equal(memoryQuest.continueCount, 1)
    assert.equal(storedQuest.continueCount, 1)
})

test("multi battle routes use the shared lifecycle boundaries", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../src/multi/http/battle.ts"),
        "utf8",
    )
    assert.match(source, /validateMultiStartRequest\(/)
    assert.match(source, /runStartEntryTransaction\(/)
    assert.match(source, /validateMultiFinishRequest\(/)
    assert.match(source, /runContinueActiveQuestTransaction\(/)
    assert.ok(
        source.indexOf("context.coordinator.startBattle(")
            < source.indexOf("runStartEntryTransaction("),
        "Hub battle identity must be fixed before the local entry transaction",
    )
    assert.ok(
        source.indexOf("context.settlementVerifier.verify(")
            < source.indexOf("getDb().transaction(executeFinishWrites)()"),
        "Hub finalization must be verified before the local settlement transaction",
    )
    assert.match(source, /const entryCost = isRoomHost[\s\S]*?: undefined;/)
    assert.match(source, /const staminaCost = isRoomHost \? getStaminaCost\(questKey\)\.cost : 0;/)
    assert.doesNotMatch(source, /activeData\.continueCount\+\+/)
})
