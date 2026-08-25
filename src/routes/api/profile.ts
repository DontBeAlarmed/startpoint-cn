/**
 * Profile API — get_my_profile.
 * Returns player profile info, settings, and party groups.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
// removed getAccountPlayers "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { getOwnedPlayerDegreeIdsSync } from "../../data/domains/degree";
import {
    getPlayerProfileSettingsSync,
    updatePlayerProfileSettingsSync,
} from "../../data/domains/option";
import { getFavoritePartyGroupListSync } from "../../lib/profileFavorite";

const PROFILE_SETTING_FIELDS = [
    "show_opened_mana_board_second_count",
    "show_owned_character_count",
    "show_owned_degree_count",
] as const

function serializeProfileSettings(
    settings: ReturnType<typeof getPlayerProfileSettingsSync>,
) {
    return {
        show_opened_mana_board_second_count: settings.showOpenedManaBoardSecondCount,
        show_owned_character_count: settings.showOwnedCharacterCount,
        show_owned_degree_count: settings.showOwnedDegreeCount,
    }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_my_profile", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account."
        })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(400).send({ error: "Bad Request", message: "Player not found." })

        const characters = getPlayerCharactersSync(playerId)
        const charCount = Object.keys(characters).length
        const degreeCount = getOwnedPlayerDegreeIdsSync(playerId, player.degreeId).length
        const profileSettings = getPlayerProfileSettingsSync(playerId)

        // Build party group list (map from DB format to client format)
        const partyGroupList = getFavoritePartyGroupListSync(
            playerId,
            player.leaderCharacterId,
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                profile_info: {
                    max_opened_mana_board_second_count: 0,
                    max_owned_character_count: charCount,
                    max_owned_degree_count: degreeCount,
                    opened_mana_board_second_count: 0,
                    owned_character_count: charCount,
                    owned_degree_count: degreeCount,
                },
                user_info: {
                    degree_id: player.degreeId,
                },
                profile_settings: serializeProfileSettings(profileSettings),
                user_party_group_list: partyGroupList,
            }
        })
    })

    // Returns the player's last login region (CN-specific)
    fastify.post("/get_last_login_region", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                region: "CN",
            }
        })
    })

    // Returns owned degree IDs for title selection
    fastify.post("/get_degree_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null
        const degreeId = player?.degreeId || 1
        const degreeIds = playerId !== null ? getOwnedPlayerDegreeIdsSync(playerId, degreeId) : [1, degreeId]

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                degree_ids: degreeIds,
            }
        })
    })

    // Set the player's displayed degree title
    fastify.post("/update_degree", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        const degreeId = body.degree_id
        if (!viewerId || isNaN(viewerId) || degreeId === undefined || isNaN(degreeId)) {
            return reply.status(400).send({
                error: "Bad Request",
                message: "Invalid request body."
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(500).send({
            error: "Internal Server Error",
            message: "No player bound to account."
        })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            error: "Internal Server Error",
            message: "Player not found."
        })

        const ownedDegreeIds = new Set(getOwnedPlayerDegreeIdsSync(playerId, player.degreeId))
        if (!ownedDegreeIds.has(Number(degreeId))) return reply.status(400).send({
            error: "Bad Request",
            message: "Degree is not owned."
        })

        updatePlayerSync({ id: playerId, degreeId: Number(degreeId) })

        console.log(`[PROFILE] update_degree viewer=${viewerId} degree=${degreeId}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                user_info: { degree_id: Number(degreeId) }
            }
        })
    })

    // Update profile visibility settings.
    fastify.post("/update_profile_settings", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const settings = body.profile_settings
        if (settings === null || typeof settings !== "object" || Array.isArray(settings)
            || !PROFILE_SETTING_FIELDS.some(field => Object.prototype.hasOwnProperty.call(settings, field))
            || PROFILE_SETTING_FIELDS.some(field => (
                Object.prototype.hasOwnProperty.call(settings, field)
                && typeof settings[field] !== "boolean"
            ))) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid profile settings.",
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account.",
        })
        const updated = updatePlayerProfileSettingsSync(playerId, {
            ...(typeof settings.show_opened_mana_board_second_count === "boolean"
                ? { showOpenedManaBoardSecondCount: settings.show_opened_mana_board_second_count }
                : {}),
            ...(typeof settings.show_owned_character_count === "boolean"
                ? { showOwnedCharacterCount: settings.show_owned_character_count }
                : {}),
            ...(typeof settings.show_owned_degree_count === "boolean"
                ? { showOwnedDegreeCount: settings.show_owned_degree_count }
                : {}),
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                profile_settings: serializeProfileSettings(updated),
            }
        })
    })

    // Update profile comment
    fastify.post("/update_comment", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account."
        })

        const comment = (body.comment || "").substring(0, 100)
        updatePlayerSync({ id: playerId, comment })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { comment },
        })
    })

    // Rename player
    fastify.post("/rename", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account."
        })

        const name = (body.name || "").substring(0, 20)
        updatePlayerSync({ id: playerId, name })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { name },
        })
    })
}

export default routes
