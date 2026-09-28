// Test-only raw-row Active Mission fact progress.
// Moved from src/lib/mission/active-fact-legacy-adapter.ts (D24 C2): production
// reconciliation evaluates planned definitions via active-fact-session; the raw
// master-row shape remains useful for pattern-level behavior assertions.
const {
    evaluateStaticActiveMissionFact,
} = require("../../src/lib/mission/active-fact-evaluator")
const { matchesRawActiveMissionQuestRange } = require("../../src/lib/mission/active-quest-range")

function parseInteger(value, field) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return parsed
}

function countRawBattleClearFacts(row, state) {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    let count = 0
    for (const quest of state.questProgress) {
        if (!matchesRawActiveMissionQuestRange(row, quest.category, quest.questId)) continue
        if (battleKind === 1) count += quest.finished ? 1 : 0
        else if (battleKind === 2) count += quest.multiClearCount
        else count += Math.max(quest.finished ? 1 : 0, quest.multiClearCount)
    }
    return count
}

function countRawSsRankFacts(row, state) {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    const hasRange = row[34] !== undefined && row[34] !== null && row[34] !== "(None)"
    if (hasRange) return null
    if (battleKind === 1) return state.battleCounters.singleRankSsCount
    if (battleKind === 2) return Math.max(0, state.battleCounters.rankSsCount - state.battleCounters.singleRankSsCount)
    return state.battleCounters.rankSsCount
}

function computeRawChapterCompleteFact(row, state) {
    const rangeKind = parseInteger(row[34], "quest range kind")
    const category = rangeKind === 0 ? 1 : rangeKind === 1 ? 4 : null
    if (category === null) return null
    const targetQuestIds = (state.chapterQuestIds[String(category)] ?? []).filter(questId => (
        matchesRawActiveMissionQuestRange(row, category, questId)
    ))
    if (targetQuestIds.length === 0) return null
    const clearRankByQuestId = new Map(state.questProgress
        .filter(progress => progress.category === category)
        .map(progress => [
            category === 4 && progress.questId < 10_000_000
                ? progress.questId + 10_000_000
                : progress.questId,
            progress.clearRank,
        ]))
    return targetQuestIds.every(questId => clearRankByQuestId.get(questId) === 5) ? 1 : 0
}

function computeRawSpecificPartyFact(row, state) {
    const characterId = parseInteger(row[46], "specific leader character id")
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    const hasRange = row[34] !== undefined && row[34] !== null && row[34] !== "(None)"
    if (!hasRange) {
        const clears = state.leaderClearCounts[String(characterId)] ?? { all: 0, multi: 0 }
        if (battleKind === 1) return Math.max(0, clears.all - clears.multi)
        if (battleKind === 2) return clears.multi
        return clears.all
    }
    if (battleKind !== 1) return null
    return state.questProgress.filter(progress => (
        progress.finished
        && progress.leaderCharacterId === characterId
        && matchesRawActiveMissionQuestRange(row, progress.category, progress.questId)
    )).length
}

/** Raw master-row fact progress; intentionally does not use planned parsing. */
function computeActiveMissionFactProgress(pattern, row, state, missionId) {
    if (pattern === 23) return countRawBattleClearFacts(row, state)
    if (pattern === 26) return countRawSsRankFacts(row, state)
    if (pattern === 66) return computeRawChapterCompleteFact(row, state)
    if (pattern === 65) return row[34] === "11" ? state.practiceQuestChallengeCount : null
    if (pattern === 70) return computeRawSpecificPartyFact(row, state)
    return evaluateStaticActiveMissionFact({ missionId, pattern, row, questRange: null }, state)
}

module.exports = { computeActiveMissionFactProgress }
