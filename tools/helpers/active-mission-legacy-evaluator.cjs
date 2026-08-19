"use strict"

// Frozen from commit 882a4cea. Keep this oracle independent from production refactors.
const CHARACTER_EXP_CAPS = Object.freeze({
    1: Object.freeze([11416, 15820, 21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    2: Object.freeze([21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    3: Object.freeze([37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    4: Object.freeze([76272, 102829, 139190, 189995, 240800, 291605, 342410]),
    5: Object.freeze([153988, 210488, 266988, 323488, 379988]),
})

const QUEST_CATEGORY_BY_RANGE_KIND = Object.freeze({
    0: 1, 1: 4, 2: 2, 3: 6, 4: 14, 5: 7, 6: 10, 7: 13, 8: 11,
    9: 18, 10: 19, 11: 15, 12: [6, 14, 13, 20], 13: 20, 14: 21,
    15: 22, 16: 23, 17: 24, 18: 25, 19: 26, 20: 27,
})

function parseInteger(value, field) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return parsed
}

function parseIntegerList(value, field) {
    if (value === "(None)" || value === undefined || value === null) return []
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    const text = String(value)
    return text.length === 0 ? [] : text.split(",").map(item => parseInteger(item, field))
}

function parseOptionalIntegerList(value, field) {
    if (value === undefined || value === null || value === "(None)") return null
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return String(value).length === 0
        ? []
        : String(value).split(",").map(item => parseInteger(item, field))
}

function matchesOptionalSelector(selector, value) {
    return selector === null || selector.includes(value)
}

function matchesActiveMissionQuestRange(row, category, questId) {
    const rawKind = row[34]
    if (rawKind === undefined || rawKind === null || rawKind === "(None)") return true
    const kind = parseInteger(rawKind, "quest range kind")
    const rawCategories = QUEST_CATEGORY_BY_RANGE_KIND[kind]
    if (rawCategories === undefined) return false
    const categories = Array.isArray(rawCategories) ? rawCategories : [rawCategories]
    if (!categories.includes(category)) return false
    if (kind === 0 || kind === 1 || kind === 2) {
        const normalized = kind === 1 && questId < 10_000_000 ? questId + 10_000_000 : questId
        const ranged = kind === 1 ? normalized - 10_000_000 : normalized
        const first = Math.floor(ranged / 1_000_000)
        const remainder = ranged % 1_000_000
        return matchesOptionalSelector(parseOptionalIntegerList(row[35], "quest range first"), first)
            && matchesOptionalSelector(
                parseOptionalIntegerList(row[36], "quest range second"),
                Math.floor(remainder / 1_000),
            )
            && matchesOptionalSelector(parseOptionalIntegerList(row[37], "quest range third"), remainder % 1_000)
    }
    if (kind === 12) return true
    return matchesOptionalSelector(parseOptionalIntegerList(row[35], "quest event id"), Math.floor(questId / 1_000))
        && matchesOptionalSelector(parseOptionalIntegerList(row[37], "quest numbers"), questId % 1_000)
}

function requireNonEmpty(values, field) {
    if (values.length === 0) throw new TypeError(`Missing Active Mission ${field}.`)
    return values
}

function cartesianQuestIds(first, second, third, base) {
    const ids = []
    for (const firstId of first) for (const secondId of second) for (const thirdId of third) {
        ids.push(base + firstId * 1_000_000 + secondId * 1_000 + thirdId)
    }
    return ids
}

function resolveActiveMissionQuestIds(row) {
    const kind = parseInteger(row[34], "quest range kind")
    if (kind === 0 || kind === 1) {
        return [...new Set(cartesianQuestIds(
            requireNonEmpty(parseIntegerList(row[35], "quest worlds"), "quest worlds"),
            requireNonEmpty(parseIntegerList(row[36], "quest chapters"), "quest chapters"),
            requireNonEmpty(parseIntegerList(row[37], "quest numbers"), "quest numbers"),
            kind === 1 ? 10_000_000 : 0,
        ))]
    }
    if (kind === 9) {
        const eventId = parseInteger(row[35], "world story event id")
        const questNumbers = requireNonEmpty(
            parseIntegerList(row[37], "world story event quest numbers"),
            "world story event quest numbers",
        )
        return [...new Set(questNumbers.map(questNumber => eventId * 1_000 + questNumber))]
    }
    throw new TypeError(`Unsupported Active Mission quest range kind ${kind}.`)
}

function estimateCharacterLevel(character) {
    const caps = CHARACTER_EXP_CAPS[character.rarity]
    if (!caps || caps.length === 0) return 0
    const baseLevel = 40 + (character.rarity - 1) * 10
    let level = baseLevel - 1
    for (let index = 0; index < caps.length; index++) {
        if (character.exp < caps[index]) break
        level = baseLevel + index * 5
    }
    return level
}

function countBattleClearFacts(row, progress) {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    let count = 0
    for (const quest of progress) {
        if (!matchesActiveMissionQuestRange(row, quest.category, quest.questId)) continue
        if (battleKind === 1) count += quest.finished ? 1 : 0
        else if (battleKind === 2) count += quest.multiClearCount
        else count += Math.max(quest.finished ? 1 : 0, quest.multiClearCount)
    }
    return count
}

function countSsRankFacts(row, state) {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    if (row[34] !== undefined && row[34] !== null && row[34] !== "(None)") return null
    if (battleKind === 1) return state.battleCounters.singleRankSsCount
    if (battleKind === 2) return Math.max(0, state.battleCounters.rankSsCount - state.battleCounters.singleRankSsCount)
    return state.battleCounters.rankSsCount
}

function computeChapterCompleteFact(row, state) {
    const kind = parseInteger(row[34], "quest range kind")
    const category = kind === 0 ? 1 : kind === 1 ? 4 : null
    if (category === null) return null
    const targets = (state.chapterQuestIds[String(category)] ?? [])
        .filter(questId => matchesActiveMissionQuestRange(row, category, questId))
    if (targets.length === 0) return null
    const ranks = new Map(state.questProgress.filter(item => item.category === category).map(item => [
        category === 4 && item.questId < 10_000_000 ? item.questId + 10_000_000 : item.questId,
        item.clearRank,
    ]))
    return targets.every(questId => ranks.get(questId) === 5) ? 1 : 0
}

function computeSpecificPartyClearFact(row, state) {
    const characterId = parseInteger(row[46], "specific leader character id")
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    const hasRange = row[34] !== undefined && row[34] !== null && row[34] !== "(None)"
    if (!hasRange) {
        const clears = state.leaderClearCounts[String(characterId)] ?? { all: 0, multi: 0 }
        if (battleKind === 1) return Math.max(0, clears.all - clears.multi)
        return battleKind === 2 ? clears.multi : clears.all
    }
    if (battleKind !== 1) return null
    return state.questProgress.filter(item => item.finished
        && item.leaderCharacterId === characterId
        && matchesActiveMissionQuestRange(row, item.category, item.questId)).length
}

function computeActiveMissionFactProgress(pattern, row, state, missionId) {
    const characters = Object.entries(state.characters)
    switch (pattern) {
        case 0: return Math.max(0, state.player.totalLoginDays)
        case 39: return Math.max(0, state.player.totalStaminaUsed)
        case 46: return state.totalUsedManaCount
        case 78: return state.totalGachaCharacterCount
        case 14: return state.battleCounters.singleClearCount
        case 16: return state.battleCounters.multiClearCount
        case 17: return state.battleCounters.multiHostClearCount
        case 58: return state.totalEquipmentEquipCount
        case 59: return state.totalUnisonSetCount
        case 60: return state.totalPartyCharacterSetCount
        case 63: return state.totalInjectedExpCount
        case 83: return state.totalGachaCampaignCount
        case 23: return countBattleClearFacts(row, state.questProgress)
        case 26: return countSsRankFacts(row, state)
        case 66: return computeChapterCompleteFact(row, state)
        case 65: return row[34] === "11" ? state.practiceQuestChallengeCount : null
        case 70: return computeSpecificPartyClearFact(row, state)
        case 71: case 72: case 73: {
            const characterId = parseInteger(row[43], "conditional battle character id")
            return state.conditionalBattleFacts[`${pattern}:${characterId}`] ?? 0
        }
        case 89: case 90: case 91:
            return missionId === undefined ? null : state.loadoutBattleFacts[String(missionId)] ?? 0
        case 21: {
            const questIds = new Set(characters.flatMap(([id]) => state.characterStoryQuestIds[id] ?? []))
            return [...questIds].filter(questId => state.finishedQuestIds.has(questId)).length
        }
        case 5: return characters.reduce((max, [, character]) => Math.max(max, estimateCharacterLevel(character)), 0)
        case 4: {
            const target = row[43]
            return target === undefined || target === null || target === "(None)"
                ? characters.length : state.characters[String(target)] === undefined ? 0 : 1
        }
        case 61: return characters.filter(([, character]) => character.evolutionLevel > 0).length
        case 36: return state.equipment.filter(item => item.level >= item.maxLevel).length
        case 34: return state.equipment.reduce((total, item) => total + Math.max(0, item.level - 1), 0)
        case 35: return state.partyAbilitySoulCount
        case 45: return state.treasureShopPurchaseCount
        case 64: return state.bossCoinEquipmentShopPurchaseCount
        case 84: return state.bossCoinShopPurchaseCount
        case 9: return characters.reduce((total, [, character]) => total + Math.max(0, character.overLimitStep), 0)
        case 8: return characters.reduce((total, [, character]) => (
            total + character.bondTokenList.filter(token => token.status >= 1).length
        ), 0)
        case 7: return Object.values(state.manaNodes).reduce((total, nodes) => total + nodes.length, 0)
        case 62: return Object.entries(state.manaNodes).reduce((total, [id, nodes]) => {
            const slots = state.manaNodeSlots[id] ?? {}
            return total + nodes.filter(nodeId => slots[String(nodeId)] >= 1 && slots[String(nodeId)] <= 3).length
        }, 0)
        case 48: return Object.entries(state.manaBoardNodes).filter(([id, boards]) => {
            const second = boards["2"] ?? []
            const unlocked = new Set(state.manaNodes[id] ?? [])
            return second.length > 0 && second.every(nodeId => unlocked.has(nodeId))
        }).length
        default: return null
    }
}

function isMissionComplete(missionId, activeMissions, rewardTable) {
    const rawStages = rewardTable[String(missionId)]
    if (!rawStages || typeof rawStages !== "object" || Array.isArray(rawStages)) return false
    const stages = Object.values(rawStages)
    if (stages.length === 0) return false
    const progress = activeMissions[String(missionId)]?.progress ?? 0
    return stages.every(rows => {
        const row = Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) ? rows[0] : null
        const target = row === null ? Number.NaN : Number(row[3])
        return Number.isFinite(target) && progress >= target
    })
}

function computeAuthoritativeProgress(definition, state, activeMissions, rewardTable) {
    const pattern = parseInteger(definition.row[29], "mission pattern")
    const fact = computeActiveMissionFactProgress(pattern, definition.row, state, definition.missionId)
    if (fact !== null) return fact
    if (pattern === 57) {
        return resolveActiveMissionQuestIds(definition.row)
            .filter(questId => state.finishedQuestIds.has(questId)).length
    }
    if (pattern === 13) {
        return parseIntegerList(definition.row[55], "target mission ids").reduce((count, missionId) => (
            count + (isMissionComplete(missionId, activeMissions, rewardTable) ? 1 : 0)
        ), 0)
    }
    return null
}

module.exports = {
    computeAuthoritativeProgress,
    matchesActiveMissionQuestRange,
    resolveActiveMissionQuestIds,
}
