import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import itemLookup from "../../../assets/item_lookup.json";
import equipmentLookup from "../../../assets/equipment_lookup.json";
import bundledQuestLookup from "../../../assets/quest_lookup.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import { getCharacterLookup } from "../../lib/character-content";

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/characters", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getCharacterLookup())
    })

    fastify.get("/items", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(itemLookup)
    })

    fastify.get("/equipment", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(equipmentLookup)
    })

    fastify.get("/quests", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getRuntimeContentTableSync(
            "quest_lookup.json",
            bundledQuestLookup,
        ))
    })
}

export default routes;
