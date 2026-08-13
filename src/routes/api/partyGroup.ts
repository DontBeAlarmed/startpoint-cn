// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers } from "../../data/domains/account"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { updatePlayerPartyGroupSync } from "../../data/domains/party"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { PartyCategory } from "../../data/types";
import { hasValidPartyCategory, isPartyGroupAllowedForCategory } from "../../lib/special-event-parties";
import { getDb } from "../../data/db";

interface EditBody {
    viewer_id: number
    api_count: number
    retry_count: number
    party_group_edit_params_list: {
        party_group_id: number,
        party_category: number,
        party_group_color_id: number
    }[]
}

class PartyGroupNotFoundError extends Error {}

function isValidEditParams(value: unknown): value is EditBody["party_group_edit_params_list"][number] {
    if (!hasValidPartyCategory(value)) return false
    const params = value as Record<string, unknown>
    return Number.isSafeInteger(params.party_group_id)
        && isPartyGroupAllowedForCategory(
            params.party_category as PartyCategory,
            params.party_group_id as number,
        )
        && Number.isSafeInteger(params.party_group_color_id)
        && (params.party_group_color_id as number) > 0
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/edit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EditBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        if (!Array.isArray(body.party_group_edit_params_list)
            || body.party_group_edit_params_list.some(params => !isValidEditParams(params))) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid party category."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        try {
            getDb().transaction(() => {
                for (const editParamsList of body.party_group_edit_params_list) {
                    if (!updatePlayerPartyGroupSync(
                        playerId,
                        editParamsList.party_group_id,
                        editParamsList.party_group_color_id,
                        editParamsList.party_category as PartyCategory,
                    )) throw new PartyGroupNotFoundError()
                }
            })()
        } catch (error) {
            if (error instanceof PartyGroupNotFoundError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Party group does not exist."
                })
            }
            throw error
        }
        
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        })
    })
}

export default routes;
