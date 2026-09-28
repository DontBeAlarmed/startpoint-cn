import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getQuestLookup } from "../../lib/quest-content";
import { getEquipmentLookupSync } from "../../lib/equipment-content";
import { getItemLookupSync } from "../../lib/item-content";
import { getCharacterLookup } from "../../lib/character-content";
import { getItemInventoryPolicyCatalog } from "../../lib/inventory/item-inventory-policy";

function getItemMaxCountLookup(): Readonly<Record<string, number>> {
    const { byItemId } = getItemInventoryPolicyCatalog()
    return Object.fromEntries(
        Object.entries(byItemId).map(([itemId, policy]) => [itemId, policy.maxCount]),
    )
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/characters", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getCharacterLookup())
    })

    fastify.get("/items", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getItemLookupSync())
    })

    fastify.get("/item-max-counts", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getItemMaxCountLookup())
    })

    fastify.get("/equipment", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getEquipmentLookupSync())
    })

    fastify.get("/quests", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getQuestLookup())
    })
}

export default routes;
