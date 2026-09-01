// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharacterSync, updatePlayerCharacterSync } from "../../data/domains/character"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { givePlayerCharacterSync } from "../../lib/character";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDb } from "../../data/db";
import { executeOverLimit } from "../../lib/character-growth/commands/over-limit"
import { executeBulkOverLimit } from "../../lib/character-growth/commands/bulk-over-limit"
import { sendGrowthMutationError } from "./character/mana-mutation-http"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { canClaimTownStoryCharacter } from "../../lib/story-join-character";
import { getRealNow } from "../../runtime/time/game-time";
import {
    FULL_CHARACTER_GROWTH_FIELDS,
    OVER_LIMIT_CHARACTER_GROWTH_FIELDS,
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
    projectCharacterGrowthIncrement,
} from "../../lib/character-growth/response-projector"

interface OverLimitBody {
    viewer_id: number
    character_id: number
    api_count: number
    use_stack: boolean
    item_id: number,
    over_limit_count: number
}

interface SetIllustrationSettingsBody {
    character_id: number,
    api_count: number,
    illustration_settings: number[],
    viewer_id: number
}

interface SetProtectionBody {
    character_ids: number[]
    protection: boolean
    viewer_id: number
    api_count: number
}

function growthFailure(reply: FastifyReply, error: unknown) {
    if (sendGrowthMutationError(reply, error)) return
    throw error
}

export const characterMaxOverLimits: Record<number, number> = {
    [1]: 12, // 1* max over limit count
    [2]: 10, // 2* max over limit count
    [3]: 8,  // 3* max over limit count 
    [4]: 6,  // 4* max over limit count
    [5]: 4,  // 5* max over limit count 
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/set_protection", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetProtectionBody
        const viewerId = body.viewer_id
        const characterIds = body.character_ids

        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Array.isArray(characterIds)
            || characterIds.some(id => !Number.isSafeInteger(id) || id <= 0)
            || typeof body.protection !== "boolean") {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null || getPlayerSync(playerId) === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const uniqueCharacterIds = [...new Set(characterIds)]
        getDb().transaction(() => {
            for (const characterId of uniqueCharacterIds) {
                if (getPlayerCharacterSync(playerId, characterId) !== null) {
                    updatePlayerCharacterSync(playerId, characterId, {
                        protection: body.protection
                    })
                }
            }
        })()

        const characterList = uniqueCharacterIds.flatMap(characterId => {
            const character = getPlayerCharacterSync(playerId, characterId)
            if (!character) return []
            return [projectCharacterGrowthEntry({
                characterId,
                character,
                state: characterGrowthProjectionStateFromPlayerCharacter(characterId, character),
                fields: [...FULL_CHARACTER_GROWTH_FIELDS, "evolution_img_level"],
                viewerId,
            })]
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": characterList,
                "mail_arrived": getMailArrivedSync(playerId),
            }
        })
    })

    fastify.post("/set_illustration_settings", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetIllustrationSettingsBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const illustration_settings = body.illustration_settings
        if (!Number.isSafeInteger(viewerId)
            || viewerId <= 0
            || !Number.isSafeInteger(characterId)
            || characterId <= 0
            || !Array.isArray(illustration_settings)
            || illustration_settings.length !== 6
            || illustration_settings.some(value => !Number.isSafeInteger(value) || value < 0)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player id
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        if (getPlayerCharacterSync(playerId, characterId) === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // update character
        updatePlayerCharacterSync(playerId, characterId, {
            illustrationSettings: illustration_settings
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        }) 
    })

    fastify.post("/over_limit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as OverLimitBody
        const viewerId = body.viewer_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return reply.status(400).send({
            error: "Bad Request", message: "Invalid request body.",
        })
        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request", message: "Invalid viewer id.",
        })
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)
        if (playerId === null || getPlayerSync(playerId) === null) return reply.status(500).send({
            error: "Internal Server Error", message: "No players bound to account.",
        })
        try {
            const result = executeOverLimit({
                playerId,
                characterId: body.character_id,
                overLimitCount: body.over_limit_count,
                useStack: body.use_stack,
                itemId: body.item_id,
                evaluationTime: getRealNow(),
            })
            const character = getPlayerCharacterSync(playerId, body.character_id)!
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    character_list: [...projectCharacterGrowthIncrement({
                        after: result.after,
                        changedNodeIds: [],
                    }, {
                        character,
                        fields: OVER_LIMIT_CHARACTER_GROWTH_FIELDS,
                    }).character_list],
                    item_list: result.itemId === undefined ? {} : { [result.itemId]: result.itemCount },
                    mail_arrived: getMailArrivedSync(playerId),
                },
            })
        } catch (error) {
            return growthFailure(reply, error)
        }
    })

    fastify.post("/bulk_over_limit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number; api_count?: number }

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request", message: "Invalid request body.",
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request", message: "Invalid viewer id.",
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null
        if (player === null) return reply.status(500).send({
            error: "Internal Server Error", message: "No players bound to account.",
        })

        try {
            const result = executeBulkOverLimit({ playerId, evaluationTime: getRealNow() })
            const characterList = result.characters.map(character => {
                const written = result.projectionCharacters[String(character.characterId)]!
                return projectCharacterGrowthIncrement(
                    { after: character, changedNodeIds: [] },
                    { character: written, fields: OVER_LIMIT_CHARACTER_GROWTH_FIELDS },
                ).character_list[0]
            })

            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    character_list: characterList,
                    mail_arrived: getMailArrivedSync(playerId),
                },
            })
        } catch (error) {
            return growthFailure(reply, error)
        }
    })

    fastify.post("/add_character_from_town", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { character_id: number, viewer_id: number, api_count: number }
        const viewerId = body.viewer_id
        const characterId = body.character_id
        if (!viewerId || isNaN(viewerId) || !characterId || isNaN(characterId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const giveResult = getDb().transaction(() => {
            if (!canClaimTownStoryCharacter(playerId, characterId)) return null
            return givePlayerCharacterSync(playerId, characterId)
        })()
        if (!giveResult?.character) return reply.status(400).send({
            "error": "Bad Request", "message": "Character is not available from town."
        })
        const existingCharacterList: Record<string, unknown>[] = giveResult?.character
            ? [giveResult.character as Record<string, unknown>]
            : []
        const itemList = giveResult?.item
            ? { [giveResult.item.id]: giveResult.item.count }
            : {}
        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            [characterId],
            [existingCharacterList],
            {},
            "character/add_character_from_town",
        ).characterList

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": characterList,
                "item_list": itemList,
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })
}

export default routes;
