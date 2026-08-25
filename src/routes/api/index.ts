import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../../data/types";
import { getDb } from "../../data/db";
import { getClientSerializedData, serializePlayerData } from "../../data/utils";
import { collectPlayerDataPooledExpSync, collectPlayerPooledExpSync, dailyResetPlayerDataSync, getPlayerDailyChallengePointListSync, getPlayerSync, refreshPlayerDailyChallengePointsForRealDaySync, updatePlayerSync } from "../../data/domains/player"
import { getPlayerActiveMissionsSync, getPlayerClearedRegularMissionListSync } from "../../data/domains/mission"
import { getPlayerBoxGachasSync } from "../../data/domains/boxGacha"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerDrawnQuestsSync, getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerGachaInfoListSync } from "../../data/domains/gacha"
import { getPlayerItemsSync } from "../../data/domains/item"
import { getPlayerMultiSpecialExchangeCampaignsSync, getPlayerPeriodicRewardPointsSync, getPlayerStartDashExchangeCampaignsSync } from "../../data/domains/campaign"
import { getPlayerOptionsSync } from "../../data/domains/option"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getPlayerTriggeredTutorialsSync } from "../../data/domains/tutorial"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { getRealNow } from "../../runtime/time/game-time";

interface LoadBody {
    app_secret: string,
    graphics_device_name: string,
    device_id: number,
    access_token: string,
    storage_directory_path: string,
    app_admin: string,
    kakao_pid: string,
    keychain: number,
    viewer_id: number,
    platform_os_version: string
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/load", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoadBody

        const zat = body.access_token
        let viewerId = body.viewer_id
        if (!zat || !viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(zat)
        if (session === null || session.type !== SessionType.ZAT) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid zat provided."
        })

        const viewerSession = await getSession(String(viewerId))
        if (viewerSession === null || viewerSession.type !== SessionType.VIEWER) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer ID provided."
        })

        const accountId = session.accountId

        const playerId = resolvePlayerIdSync(accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get last login time
        dailyResetPlayerDataSync(player)
        getDb().transaction(() => {
            refreshPlayerDailyChallengePointsForRealDaySync(playerId, getRealNow())
        })()

        // collect the player's pooled exp
        collectPlayerDataPooledExpSync(player)

        const clientData = getClientSerializedData(playerId, {
            viewerId: viewerId,
            playerOverride: player,
        })
        if (clientData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                asset_update: true,
                viewer_id: viewerId
            }),
            "data": clientData
        })
    })
}

export default routes;
