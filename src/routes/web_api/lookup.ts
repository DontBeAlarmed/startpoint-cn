import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bundledQuestLookup from "../../../assets/quest_lookup.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import { getEquipmentLookupSync, getItemLookupSync } from "../../lib/assets";
import { getCharacterLookup } from "../../lib/character-content";

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/characters", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getCharacterLookup())
    })

    fastify.get("/items", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getItemLookupSync())
    })

    fastify.get("/equipment", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getEquipmentLookupSync())
    })

    fastify.get("/quests", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getRuntimeContentTableSync(
            "quest_lookup.json",
            bundledQuestLookup,
        ))
    })
}

export default routes;
