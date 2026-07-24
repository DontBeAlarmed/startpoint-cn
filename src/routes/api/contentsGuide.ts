import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import {
    startContentsGuideMission,
    StartContentsGuideMissionInput,
    StartContentsGuideMissionResult,
} from "../../lib/mission/contents-guide-start"
import { generateDataHeaders, getServerTime } from "../../utils";

interface StartBody {
    event_id: number,
    viewer_id: number,
    api_count: number
}

export interface ContentsGuideRoutesOptions {
    readonly startMission?: (
        input: StartContentsGuideMissionInput,
    ) => StartContentsGuideMissionResult
}

const routes = async (
    fastify: FastifyInstance,
    options: ContentsGuideRoutesOptions = {},
) => {
    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody | null;

        const viewerId = body?.viewer_id;
        const eventId = body?.event_id;
        if (typeof viewerId !== "number" || !Number.isSafeInteger(viewerId) || viewerId <= 0
            || typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId <= 0) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null || !getPlayerSync(playerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid player."
        })

        const snapshot = getContentSnapshot()
        const result = (options.startMission ?? startContentsGuideMission)({
            playerId,
            eventId,
            repository: snapshot.repository,
            now: getServerTime() * 1000,
        })
        if (!result.ok) return reply.status(400).send({
            "error": "Bad Request", "message": result.message
        })

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "active_mission_list": result.delta === null ? [] : [result.delta]
            }
        });
    });
};

export default routes;
