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
    updatePlayerItemSync(_playerId, itemId, amount) {
        if (itemId === 100) staminaItemCount = amount
    },
    givePlayerItemSync: () => 0,
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => null,
    playerOwnsEquipmentSync: (_playerId, equipmentId) => equipmentId === 500001,
    updatePlayerEquipmentSync(_playerId, equipmentId, patch) {
        if (equipmentId === 500001) equipmentProtected = patch.protection
    },
})
stubModule("../src/lib/assets", {
    getConfigSync: () => ({ max_stamina_overflow: 999, craft_point_item_id: 100000 }),
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
stubModule("../src/data/db", { getDb: () => { throw new Error("unexpected database access") } })
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
