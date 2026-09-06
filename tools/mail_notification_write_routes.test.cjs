const assert = require("node:assert/strict")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const player = { id: 7, stamina: 10, staminaHealTime: new Date(0) }
let staminaItemCount = 2
let equipmentProtected = false
const mailLookups = []

stubModule("../src/data/domains/session", {
    getSession: async viewerId => viewerId === "123" ? { accountId: 9 } : null,
})
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 7 })
stubModule("../src/data/domains/player", {
    getPlayerSync: playerId => playerId === 7 ? player : null,
    updatePlayerSync(patch) {
        Object.assign(player, patch)
    },
})
stubModule("../src/data/domains/item", {
    getPlayerItemSync: (_playerId, itemId) => itemId === 100 ? staminaItemCount : 0,
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => null,
    playerOwnsEquipmentSync: (_playerId, equipmentId) => equipmentId === 500001,
    updatePlayerEquipmentSync(_playerId, equipmentId, patch) {
        if (equipmentId === 500001) equipmentProtected = patch.protection
    },
})
stubModule("../src/lib/assets", {
})
stubModule("../src/lib/config-content", {
    getEquipmentCurrencyPolicySync: () => ({ craftPointItemId: 100000, starGrainItemId: 990008 }),
    getStaminaPolicySync: () => ({ maxOverflow: 999 }),
})
stubModule("../src/lib/item-content", {
    getItemEffectSync: itemId => itemId === 100
        ? { effectKind: 2, effectValue: 1 }
        : null,
})
stubModule("../src/lib/equipment-content", {
    getEquipmentCraftSync: () => null,
    getEquipmentDissolveSync: () => null,
})
stubModule("../src/lib/stamina", { computeRealTimeStamina: () => 10 })
stubModule("../src/lib/item-sell", { sellItemSync: () => { throw new Error("unexpected sell") } })
stubModule("../src/lib/mission", { reconcileAwakeUnlockCharacterList: (_playerId, list) => list })
stubModule("../src/lib/equipment", {
    buildFullEquipmentList: () => [],
    clientSerializeEquipment: value => value,
})
stubModule("../src/lib/equipment-upgrade", { canUseEquipmentAwakeningCrystal: () => false })
let inTransaction = false
const database = {
    get inTransaction() {
        return inTransaction
    },
    transaction(operation) {
        return () => {
            inTransaction = true
            try {
                return operation()
            } finally {
                inTransaction = false
            }
        }
    },
}
stubModule("../src/data/db", { getDb: () => database })
class ItemUseValidationError extends Error {
    constructor(message, resultCode) {
        super(message)
        this.resultCode = resultCode
    }
}
class ItemUsePlayerNotFoundError extends Error {}
stubModule("../src/lib/item-use-settlement", {
    ItemUseValidationError,
    ItemUsePlayerNotFoundError,
    settleItemUseInCallerTransactionSync(playerId, body, maxStaminaOverflow) {
        assert.equal(database.inTransaction, true)
        assert.equal(playerId, 7)
        assert.equal(maxStaminaOverflow, 999)
        assert.deepEqual(body.items, [{ id: 100, number: 1, selectIndex: 0 }])

        const beforeCount = staminaItemCount
        const beforeStamina = player.stamina
        const recoveryTime = new Date(1_000)
        staminaItemCount -= 1
        player.stamina += 1
        player.staminaHealTime = recoveryTime

        return {
            plan: {
                inventoryChanges: [{
                    id: 100,
                    beforeCount,
                    deductionCount: 1,
                    rewardCount: 0,
                    finalCount: staminaItemCount,
                }],
                rewards: [],
                stamina: {
                    current: beforeStamina,
                    recovery: 1,
                    after: player.stamina,
                    recoveryTime,
                },
            },
            itemList: { "100": staminaItemCount },
        }
    },
})
stubModule("../src/lib/mail-notification", {
    getMailArrivedSync(playerId) {
        mailLookups.push(playerId)
        return true
    },
})
stubModule("../src/utils", {
    generateDataHeaders: values => ({ viewer_id: values.viewer_id, result_code: values.result_code ?? 1 }),
    realToVirtual: date => date.getTime() / 1000,
})

const itemRoutes = require("../src/routes/api/item.ts").default
const equipmentRoutes = require("../src/routes/api/equipment.ts").default

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", async (_request, reply, payload) => {
        if (!String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) return payload
        return pack(payload)
    })
    await fastify.register(itemRoutes, { prefix: "/item" })
    await fastify.register(equipmentRoutes, { prefix: "/equipment" })
    await fastify.ready()

    try {
        const itemResponse = await fastify.inject({
            method: "POST",
            url: "/item/use_item",
            payload: {
                viewer_id: 123,
                items: [{ id: 100, number: 1, selectIndex: 0 }],
            },
        })
        assert.equal(itemResponse.statusCode, 200, itemResponse.body)
        assert.equal(unpack(itemResponse.rawPayload).data.mail_arrived, true)
        assert.equal(staminaItemCount, 1)

        const equipmentResponse = await fastify.inject({
            method: "POST",
            url: "/equipment/set_protection",
            payload: {
                viewer_id: 123,
                protection: true,
                equipment_ids: [500001],
            },
        })
        assert.equal(equipmentResponse.statusCode, 200, equipmentResponse.body)
        assert.equal(unpack(equipmentResponse.rawPayload).data.mail_arrived, true)
        assert.equal(equipmentProtected, true)
        assert.deepEqual(mailLookups, [7, 7])
    } finally {
        await fastify.close()
    }
}

main().then(
    () => console.log("mail notification write route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
