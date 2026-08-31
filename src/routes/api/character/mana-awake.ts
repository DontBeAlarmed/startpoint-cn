import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import { getPlayerSync } from "../../../data/domains/player"
import { executeAwakeManaNodes } from "../../../lib/character-growth/commands/awake-mana-nodes"
import {
    buildCharacterListEntryFromGrowth,
    validateCharacterOwnership,
    validateSessionAndPlayer,
    sendCharacterResponse,
} from "../../../lib/character-helpers"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import { mapToRecord } from "../../../lib/character-growth/resource-plan"
import { sendGrowthMutationError } from "./mana-mutation-http"
import { getServerDate } from "../../../utils"

interface AwakeManaNodeBody {
    viewer_id: number
    character_id: number
    api_count?: number
    mana_node_multiplied_id_list: number[]
    awake_level: number
}

export function registerAwakeManaNodeRoute(fastify: FastifyInstance): void {
    fastify.post("/awake_mana_node", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AwakeManaNodeBody
        const viewerId = body?.viewer_id
        const characterId = body?.character_id
        const nodeIds = body?.mana_node_multiplied_id_list
        const targetAwakeLevel = body?.awake_level
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(characterId) || characterId <= 0
            || !Array.isArray(nodeIds)
            || !Number.isSafeInteger(targetAwakeLevel) || targetAwakeLevel <= 0) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }

        const session = await validateSessionAndPlayer(viewerId, reply)
        if (!session) return
        if (!validateCharacterOwnership(session.playerId, characterId, reply)) return

        let result
        try {
            result = executeAwakeManaNodes({
                playerId: session.playerId,
                characterId,
                requestedNodeIds: nodeIds,
                targetAwakeLevel,
                evaluationTime: getServerDate(),
            })
        } catch (error) {
            console.warn(
                `[MANA] awake_mana_node rejected: player=${session.playerId} char=${characterId}`
                + ` board=${getPlayerCharacterSync(session.playerId, characterId)?.manaBoardIndex ?? "unknown"}`
                + ` code=${(error && typeof error === "object" && "code" in error) ? String(error.code) : "unknown"}`
                + ` nodes=${nodeIds.length}`,
            )
            if (sendGrowthMutationError(reply, error)) return
            throw error
        }
        const player = getPlayerSync(session.playerId)
        const character = getPlayerCharacterSync(session.playerId, characterId)
        if (!player || !character) return reply.status(500).send({ error: "Internal Server Error", message: "Growth state unavailable." })
        const resourceState = result.resourceState
        const characterList = [buildCharacterListEntryFromGrowth(
            characterId,
            character,
            result.after,
            result.manaBoardAwake === undefined ? {} : { mana_board_awake: result.manaBoardAwake },
        )]
        return sendCharacterResponse(reply, viewerId, {
            user_info: {
                free_mana: resourceState?.freeMana ?? player.freeMana,
                paid_mana: resourceState?.paidMana ?? player.paidMana,
            },
            character_list: characterList,
            user_character_mana_node_list: {
                [String(characterId)]: [...result.responseNodeEntries],
            },
            item_list: mapToRecord(resourceState?.items ?? new Map()),
            evolution: result.evolution,
            mail_arrived: getMailArrivedSync(session.playerId),
        })
    })
}
