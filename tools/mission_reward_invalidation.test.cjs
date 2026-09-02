"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const state = {
    items: new Map(),
    equipment: new Map(),
    characters: new Map(),
    playerUpdates: 0,
    passPoints: new Map(),
}

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/data/domains/item", {
    getPlayerItemSync: (_playerId, itemId) => state.items.has(Number(itemId))
        ? state.items.get(Number(itemId))
        : null,
})
stubModule("../src/data/domains/player", {
    updatePlayerSync: () => { state.playerUpdates++ },
})
stubModule("../src/lib/character", {
    givePlayerCharacterSync: (_playerId, characterId) => {
        const key = Number(characterId)
        const stack = (state.characters.get(key) ?? 0) + 1
        state.characters.set(key, stack)
        return { character: { character_id: key, stack } }
    },
})
stubModule("../src/lib/equipment", {
    givePlayerEquipmentSync: (_playerId, equipmentId, amount) => {
        const key = Number(equipmentId)
        const next = { stack: (state.equipment.get(key)?.stack ?? 0) + amount }
        state.equipment.set(key, next)
        return { equipment_id: key, ...next }
    },
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: (_playerId, equipmentId) => state.equipment.get(Number(equipmentId)) ?? null,
})
stubModule("../src/data/domains/degree", {
    givePlayerDegreeSync: (_playerId, degreeId) => degreeId === 901,
})
stubModule("../src/data/domains/pass-card", {
    addPlayerPassCardPointWithChangeSync: (_playerId, eventId, amount, maxPoint) => {
        const next = Math.min((state.passPoints.get(eventId) ?? 0) + amount, maxPoint)
        const changed = next !== (state.passPoints.get(eventId) ?? 0)
        state.passPoints.set(eventId, next)
        return { point: next, changed }
    },
})
stubModule("../src/lib/pass-card", {
    getPassCardEventDefinition: () => ({ thresholdPoint: 100 }),
})

const { MissionRewardGranter } = require("../src/lib/mission/grants")
const { createRewardGrantExecutionResult } = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

const player = Object.freeze({
    id: 1,
    freeVmoney: 10,
    freeMana: 20,
    expPool: 30,
    totalManaObtained: 40,
})

function standardRewardResult(plan, knownPlayerBefore) {
    const equipment = { equipment_id: 200, stack: 1 }
    const character = { character_id: 300, stack: 1 }
    const outcomes = plan.entries.map(entry => {
        switch (entry.type) {
            case RewardType.ITEM:
                return {
                    kind: "item",
                    item: {
                        itemId: entry.id,
                        requestedAmount: entry.count,
                        acceptedAmount: entry.count,
                        overflowAmount: 0,
                        beforeAmount: 0,
                        afterAmount: entry.count,
                    },
                }
            case RewardType.EQUIPMENT:
                return {
                    kind: "equipment",
                    equipmentId: entry.id,
                    requestedAmount: entry.count,
                    after: equipment,
                }
            case RewardType.CHARACTER:
                return {
                    kind: "character",
                    characterId: entry.id,
                    isNew: true,
                    after: character,
                    compensationItem: null,
                }
            case RewardType.BEADS:
                return {
                    kind: "currency",
                    currency: "freeVmoney",
                    requestedAmount: entry.count,
                    beforeAmount: knownPlayerBefore.freeVmoney,
                    afterAmount: knownPlayerBefore.freeVmoney + entry.count,
                }
            default:
                throw new Error(`unexpected reward type ${entry.type}`)
        }
    })
    return createRewardGrantExecutionResult(
        knownPlayerBefore.playerId,
        plan,
        outcomes,
        { ...knownPlayerBefore, freeVmoney: knownPlayerBefore.freeVmoney + 5 },
    )
}

function factIds(granter) {
    return granter.invalidatedFactKeys.map(key => {
        if (key.kind === "collectedItems") {
            return `${key.kind}:${key.itemIds === "all" ? "all" : key.itemIds.join(",")}`
        }
        if (key.kind === "passState") return `${key.kind}:${key.eventId}`
        return key.kind
    }).sort()
}

test("empty and zero-effect rewards do not create invalidation", () => {
    const granter = new MissionRewardGranter(1, player)
    granter.grant([])
    granter.grant([{ kind: 1, itemId: 100, amount: 0 }])
    granter.grant([{ kind: 2, equipmentId: 200, amount: 0 }])

    assert.deepEqual(factIds(granter), [])
})

test("item, character, equipment, player, and pass rewards expose only real changes", () => {
    const granter = new MissionRewardGranter(1, player)
    granter.grant([
        { kind: 1, itemId: 100, amount: 2 },
        { kind: 2, equipmentId: 200, amount: 1 },
        { kind: 4, characterId: 300, amount: 1 },
        { kind: 0, amount: 5 },
        { kind: 7, amount: 10 },
    ], {
        passCardEventId: 77,
        standardRewardGrant: standardRewardResult,
    })
    granter.persistPlayer()

    assert.deepEqual(factIds(granter), [
        "characters",
        "collectedItems:100",
        "equipment",
        "items",
        "passState:77",
        "player",
    ])
    assert.equal(Object.isFrozen(granter.invalidatedFactKeys), true)
    assert.equal(Object.isFrozen(granter.invalidatedFactKeys[0]), true)
})

test("duplicate pass points capped at the current value do not invalidate twice", () => {
    state.passPoints.set(88, 100)
    const granter = new MissionRewardGranter(1, player)
    granter.grant([{ kind: 7, amount: 10 }], {
        passCardEventId: 88,
        standardRewardGrant: standardRewardResult,
    })
    granter.persistPlayer()

    assert.deepEqual(factIds(granter), [])
})
