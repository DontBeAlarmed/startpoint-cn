import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { executeLearnManaNodes } from "../../../lib/character-growth/commands/learn-mana-nodes"
import { validateSessionAndPlayer, validateCharacterOwnership, sendCharacterResponse } from "../../../lib/character-helpers"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import { mapToRecord } from "../../../lib/character-growth/resource-plan"
import { sendGrowthMutationError } from "./mana-mutation-http"
import { registerAwakeManaNodeRoute } from "./mana-awake"
import { getServerDate } from "../../../utils"
import { MANA_CHARACTER_GROWTH_FIELDS, projectCharacterGrowthIncrement } from "../../../lib/character-growth/response-projector"

interface LearnManaNodeBody {
    viewer_id: number
    character_id: number
    api_count?: number
    mana_node_multiplied_id_list: number[]
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/learn_mana_node", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LearnManaNodeBody
        const viewerId = body?.viewer_id
        const characterId = body?.character_id
        const nodeIds = body?.mana_node_multiplied_id_list
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(characterId) || characterId <= 0
            || !Array.isArray(nodeIds)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }

        const session = await validateSessionAndPlayer(viewerId, reply)
        if (!session) return
        if (!validateCharacterOwnership(session.playerId, characterId, reply)) return

        let result
        try {
            result = executeLearnManaNodes({
                playerId: session.playerId,
                characterId,
                requestedNodeIds: nodeIds,
                evaluationTime: getServerDate(),
            })
        } catch (error) {
            console.warn(
                `[MANA] learn_mana_node rejected: player=${session.playerId} char=${characterId}`
                + ` code=${(error && typeof error === "object" && "code" in error) ? String(error.code) : "unknown"}`
                + ` nodes=${nodeIds.length}`,
            )
            if (sendGrowthMutationError(reply, error)) return
            throw error
        }
        const resourceState = result.resourceState
        const growthProjection = projectCharacterGrowthIncrement(result, {
            character: result.character,
            fields: MANA_CHARACTER_GROWTH_FIELDS,
            includeChangedNodes: true,
            nodeIds: result.responseNodeEntries.map(entry => entry.multiplied_id),
        })
        return sendCharacterResponse(reply, viewerId, {
            user_info: {
                free_mana: resourceState.freeMana,
                paid_mana: resourceState.paidMana,
            },
            character_list: [...growthProjection.character_list],
            user_character_mana_node_list: {
                [String(characterId)]: [
                    ...(growthProjection.user_character_mana_node_list?.[String(characterId)] ?? []),
                ],
            },
            item_list: mapToRecord(resourceState.items),
            evolution: result.evolution,
            mail_arrived: getMailArrivedSync(session.playerId),
        })
    })

    registerAwakeManaNodeRoute(fastify)
}

export default routes
