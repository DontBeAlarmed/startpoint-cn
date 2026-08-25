import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getOwnedPlayerDegreeIdsSync } from "../../data/domains/degree"
import {
    getPlayerHistorySettingsSync,
    PlayerHistorySettings,
    PlayerHistorySettingsUpdate,
    updatePlayerHistorySettingsSync,
} from "../../data/domains/player-history"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getPlayerSync } from "../../data/domains/player"
import { getAccountSync } from "../../data/domains/account"
import { getSession } from "../../data/domains/session"
import { clientSerializeDate } from "../../data/utils"
import { PartyCategory } from "../../data/types"
import { parseGlobalPartyId } from "../../lib/special-event-parties"
import {
    createEmptyPlayerHistoryTopicValues,
    loadPlayerHistoryCatalog,
    PlayerHistoryCatalog,
} from "../../lib/player-history-catalog"
import { generateDataHeaders, getServerTime } from "../../utils"

interface RequestBody {
    viewer_id?: unknown
    party_info?: unknown
    degree_id?: unknown
    background_card_id?: unknown
    player_history_topic_visible?: unknown
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

async function resolvePlayer(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as RequestBody
    if (!isPositiveInteger(body?.viewer_id)) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        return null
    }
    const session = await getSession(String(body.viewer_id))
    if (!session) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        return null
    }
    const account = getAccountSync(session.accountId)
    const playerId = resolvePlayerIdSync(session.accountId)
    const player = playerId === null ? null : getPlayerSync(playerId)
    if (!account || playerId === null || !player) {
        reply.status(400).send({ error: "Bad Request", message: "Player not found." })
        return null
    }
    return { viewerId: body.viewer_id, playerId, player, account }
}

function getFavoriteParty(playerId: number, partySlot: number, leaderCharacterId: number) {
    const groups = getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL)
    const orderedGroups = Object.entries(groups).sort(([left], [right]) => Number(left) - Number(right))
    const parsedPartyId = parseGlobalPartyId(partySlot)
    const selected = (parsedPartyId
        ? groups[String(parsedPartyId.groupId)]?.list[String(parsedPartyId.slot)]
        : undefined)
        ?? orderedGroups.flatMap(([, group]) => Object.values(group.list))[0]
    return {
        characterIds: selected?.characterIds.slice(0, 3) ?? [leaderCharacterId, null, null],
        unisonCharacterIds: selected?.unisonCharacterIds.slice(0, 3) ?? [null, null, null],
    }
}

function getDefaults(
    playerId: number,
    player: { partySlot: number, leaderCharacterId: number, degreeId: number },
    catalog: PlayerHistoryCatalog,
): PlayerHistorySettings {
    const favorite = getFavoriteParty(playerId, player.partySlot, player.leaderCharacterId)
    return {
        playerHistoryId: catalog.playerHistoryId,
        backgroundCardId: catalog.defaultBackgroundId,
        degreeId: player.degreeId,
        ...favorite,
        topicVisibility: {},
    }
}

function parseCharacterIds(value: unknown): Array<number | null> | null {
    if (!Array.isArray(value) || value.length !== 3) return null
    if (!value.every(id => id === null || isPositiveInteger(id))) return null
    return value as Array<number | null>
}

function parseTopicVisibility(value: unknown): Record<string, boolean> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const entries = Object.entries(value)
    if (!entries.every(([key, visible]) => /^[1-9]\d*$/.test(key) && typeof visible === "boolean")) return null
    return Object.fromEntries(entries) as Record<string, boolean>
}

function serializeTopics(
    catalog: PlayerHistoryCatalog,
    topicVisibility: Record<string, boolean>,
    startGameDate: Date,
) {
    return Object.fromEntries(catalog.topics.map(topic => [
        String(topic.index),
        {
            is_visible: topicVisibility[String(topic.index)] ?? topic.toggleDefault,
            value_list: topic.aggregationTarget === 0
                ? {
                    ...createEmptyPlayerHistoryTopicValues(topic.aggregationTarget),
                    date_values: [clientSerializeDate(startGameDate)],
                }
                : createEmptyPlayerHistoryTopicValues(topic.aggregationTarget),
        },
    ]))
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", async (request, reply) => {
        const resolved = await resolvePlayer(request, reply)
        if (!resolved) return
        const catalog = loadPlayerHistoryCatalog(getServerTime() * 1000)
        const defaults = getDefaults(resolved.playerId, resolved.player, catalog)
        const settings = getPlayerHistorySettingsSync(
            resolved.playerId,
            defaults,
        )
        const backgroundCardId = catalog.backgroundIds.has(settings.backgroundCardId)
            ? settings.backgroundCardId
            : catalog.defaultBackgroundId
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: resolved.viewerId }),
            data: {
                player_history_id: catalog.playerHistoryId,
                background_card_id: backgroundCardId,
                degree_id: settings.degreeId,
                favorite_character: {
                    character_ids: settings.characterIds,
                    unison_character_ids: settings.unisonCharacterIds,
                },
                player_history_topic_list: serializeTopics(
                    catalog,
                    settings.topicVisibility,
                    resolved.account.regTime,
                ),
            },
        })
    })

    fastify.post("/edit", async (request, reply) => {
        const resolved = await resolvePlayer(request, reply)
        if (!resolved) return
        const catalog = loadPlayerHistoryCatalog(getServerTime() * 1000)
        const body = request.body as RequestBody
        const fields = [
            body.party_info,
            body.degree_id,
            body.background_card_id,
            body.player_history_topic_visible,
        ].filter(value => value !== undefined && value !== null)
        if (fields.length !== 1) {
            return reply.status(400).send({ error: "Bad Request", message: "Exactly one history setting is required." })
        }

        const update: PlayerHistorySettingsUpdate = {}
        if (body.party_info !== undefined && body.party_info !== null) {
            if (typeof body.party_info !== "object" || Array.isArray(body.party_info)) {
                return reply.status(400).send({ error: "Bad Request", message: "Invalid party info." })
            }
            const party = body.party_info as Record<string, unknown>
            const characterIds = parseCharacterIds(party.character_ids)
            const unisonCharacterIds = parseCharacterIds(party.unison_character_ids)
            if (!characterIds || !unisonCharacterIds) {
                return reply.status(400).send({ error: "Bad Request", message: "Invalid party info." })
            }
            const owned = new Set(Object.keys(getPlayerCharactersSync(resolved.playerId)).map(Number))
            if (![...characterIds, ...unisonCharacterIds].every(id => id === null || owned.has(id))) {
                return reply.status(400).send({ error: "Bad Request", message: "Favorite character is not owned." })
            }
            update.characterIds = characterIds
            update.unisonCharacterIds = unisonCharacterIds
        } else if (body.degree_id !== undefined && body.degree_id !== null) {
            if (!isPositiveInteger(body.degree_id)) {
                return reply.status(400).send({ error: "Bad Request", message: "Invalid degree id." })
            }
            const owned = new Set(getOwnedPlayerDegreeIdsSync(resolved.playerId, resolved.player.degreeId))
            if (!owned.has(body.degree_id)) {
                return reply.status(400).send({ error: "Bad Request", message: "Degree is not owned." })
            }
            update.degreeId = body.degree_id
        } else if (body.background_card_id !== undefined && body.background_card_id !== null) {
            if (!isPositiveInteger(body.background_card_id)
                || !catalog.backgroundIds.has(body.background_card_id)) {
                return reply.status(400).send({ error: "Bad Request", message: "Invalid background card id." })
            }
            update.backgroundCardId = body.background_card_id
        } else {
            const visibility = parseTopicVisibility(body.player_history_topic_visible)
            const topicIndexes = new Set(catalog.topics.map(topic => String(topic.index)))
            if (!visibility || Object.keys(visibility).some(index => !topicIndexes.has(index))) {
                return reply.status(400).send({ error: "Bad Request", message: "Invalid topic visibility." })
            }
            update.topicVisibility = visibility
        }

        updatePlayerHistorySettingsSync(
            resolved.playerId,
            getDefaults(resolved.playerId, resolved.player, catalog),
            update,
        )
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: resolved.viewerId }),
            data: {},
        })
    })
}

export default routes
