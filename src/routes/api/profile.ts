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
import { generateDataHeaders, getServerDate } from "../../utils";
import { recordCollectProfileViewMissionFactsSync } from "../../lib/mission/collect-entry-facts";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge"
import { getOwnedPlayerDegreeIdsSync } from "../../data/domains/degree";
import {
    getPlayerProfileSettingsSync,
    updatePlayerProfileSettingsSync,
} from "../../data/domains/option";
import { getFavoritePartyGroupListSync } from "../../lib/profileFavorite";
import { getPlayerProfileStatsSync } from "../../lib/player-profile-stats";
import { getPlayerRankLevel } from "../../lib/player-rank-content";
import { getCharactersEvolutionImgLevels } from "../../lib/character";

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

        // Condition-88 collect missions (player_history_check): the client
        // reports nothing for them; this request is the only server-visible
        // own-profile view signal, so the fact is counted here. Record-only —
        // the collect mission screen pulls progress on open.
        recordCollectProfileViewMissionFactsSync(playerId, getServerDate())

        const characters = getPlayerCharactersSync(playerId)
        const charCount = Object.keys(characters).length
        const degreeCount = getOwnedPlayerDegreeIdsSync(playerId, player.degreeId).length
        const profileStats = getPlayerProfileStatsSync(characters)
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
                    max_opened_mana_board_second_count: profileStats.maxOpenedManaBoardSecondCount,
                    max_owned_character_count: profileStats.maxOwnedCharacterCount,
                    max_owned_degree_count: profileStats.maxOwnedDegreeCount,
                    opened_mana_board_second_count: profileStats.openedManaBoardSecondCount,
                    owned_character_count: charCount,
                    owned_degree_count: degreeCount,
                },
                ...mergeCommonResponseFragments([{
                    user_info: {
                        degree_id: player.degreeId,
                    },
                }]),
                profile_settings: serializeProfileSettings(profileSettings),
                user_party_group_list: partyGroupList,
            }
        })
    })

    // Returns the player's last login region (CN-specific)
    fastify.post("/get_profile", async (request: FastifyRequest, reply: FastifyReply) => {
        // 关注界面查看他人信息卡片（follow 列表刷新/添加后退出均触发）。
        // 客户端强校验 target_user_info 全字段（rank/role/viewer_id 必填抛
        // 8700/8701）与 favorite_character 形状（必须是含四个数组的 Object，
        // 空数组会继续取 .character_ex_boost 抛 8704）——见
        // ProfileGetProfileRealRemote.successHandler。
        const body = request.body as any
        const viewerId = body.viewer_id
        const targetViewerId = Number(body.target_viewer_id)
        if (!viewerId || isNaN(viewerId) || !Number.isSafeInteger(targetViewerId) || targetViewerId <= 0) {
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
        const emptyFavoriteCharacter = {
            character_ex_boost: [],
            character_ids: [],
            unison_character_ex_boost: [],
            unison_character_ids: [],
        }
        const targetAccountId = await getSession(String(targetViewerId))
            .then(s => s?.accountId ?? null)
            .catch(() => null)
        const targetPlayerId = targetAccountId === null ? null : resolvePlayerIdSync(targetAccountId)
        const target = targetPlayerId === null ? null : getPlayerSync(targetPlayerId)
        if (target === null || targetPlayerId === null) {
            // 未知目标：合法 stub 档案（客户端按 not-found 处理卡片）而非 404 踢登录
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    favorite_character: emptyFavoriteCharacter,
                    target_user_info: {
                        comment: "",
                        degree_id: 1,
                        follow_state: 0,
                        last_login_region: null,
                        leader_character_full_shot_evolution_level: 0,
                        max_opened_mana_board_second_count: null,
                        max_owned_character_count: null,
                        max_owned_degree_count: null,
                        name: "",
                        opened_mana_board_second_count: null,
                        owned_character_count: null,
                        owned_degree_count: null,
                        rank: 1,
                        role: 1,
                        viewer_id: targetViewerId,
                    },
                },
            })
        }
        const characters = getPlayerCharactersSync(targetPlayerId)
        const charCount = Object.keys(characters).length
        const degreeCount = getOwnedPlayerDegreeIdsSync(targetPlayerId, target.degreeId).length
        const profileStats = getPlayerProfileStatsSync(characters)
        const { getLocalFollowRelationSync } = require("../../data/domains/follow") as typeof import("../../data/domains/follow")
        const requesterPlayerId = resolvePlayerIdSync(session.accountId)
        const relation = requesterPlayerId === null
            ? null
            : getLocalFollowRelationSync(requesterPlayerId, targetPlayerId)
        // LocalFollowState 数值即客户端 follow_state（F0 冻结：1=互关 2=我关注 3=被关注）
        const followState = relation?.state ?? 0
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                favorite_character: emptyFavoriteCharacter,
                target_user_info: {
                    comment: target.comment ?? "",
                    degree_id: target.degreeId || 1,
                    follow_state: followState,
                    last_login_region: null,
                    leader_character_full_shot_evolution_level:
                        getCharactersEvolutionImgLevels(
                            targetPlayerId,
                            [target.leaderCharacterId ?? 0],
                        )[0] ?? 0,
                    max_opened_mana_board_second_count: profileStats.maxOpenedManaBoardSecondCount,
                    max_owned_character_count: profileStats.maxOwnedCharacterCount,
                    max_owned_degree_count: profileStats.maxOwnedDegreeCount,
                    name: target.name,
                    opened_mana_board_second_count: profileStats.openedManaBoardSecondCount,
                    owned_character_count: charCount,
                    owned_degree_count: degreeCount,
                    rank: getPlayerRankLevel(target.rankPoint || 0),
                    role: target.role || 1,
                    viewer_id: targetViewerId,
                },
            },
        })
    })

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


        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                ...mergeCommonResponseFragments([{ user_info: { degree_id: Number(degreeId) } }])
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
