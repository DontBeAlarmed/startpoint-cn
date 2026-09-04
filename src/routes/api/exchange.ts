import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getGameTimeContext } from "../../runtime/time/game-time";
import {
    executeStarCrumbExchangeSync,
    projectStarCrumbExchangeResponse,
} from "../../lib/star-crumb-exchange";
import {
    executeBondTokenExchangeSync,
    listBondTokenExchangeRuntimeSync,
    projectBondTokenExchangeListResponse,
    projectBondTokenExchangeResponse,
} from "../../lib/bond-token-exchange";

interface ExchangeBody {
    viewer_id: number;
    exchange_id: number;
    api_count: number;
}

interface BondTokenExchangeBody {
    viewer_id: number;
    equipment_id: number;
    api_count: number;
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/star_crumb", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeBody;

        const viewerId = body.viewer_id;
        const exchangeId = body.exchange_id;
        if (isNaN(viewerId) || isNaN(exchangeId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body.",
        });

        const viewerIdSession = await getSession(viewerId.toString());
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id.",
        });

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId);
        if (playerId === null) return reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        });

        const result = executeStarCrumbExchangeSync({ playerId, exchangeId });
        if (!result.ok) {
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            });
        }

        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            result.product.kind === "character" ? [result.product.targetId] : [],
            [result.characters],
            {},
            "exchange/star_crumb",
        ).characterList

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send(projectStarCrumbExchangeResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            characterList,
            mailArrived: getMailArrivedSync(playerId),
        }));
    });

    fastify.post("/bond_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BondTokenExchangeBody;

        const viewerId = body.viewer_id;
        const equipmentId = body.equipment_id;
        if (isNaN(viewerId) || isNaN(equipmentId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body.",
        });

        const viewerIdSession = await getSession(viewerId.toString());
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id.",
        });

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!;
        const player = playerId !== null ? getPlayerSync(playerId) : null;
        if (player === null) return reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        });

        const result = executeBondTokenExchangeSync({
            playerId,
            equipmentId,
            nowMs: getGameTimeContext().virtualNowMs,
        });
        if (!result.ok) {
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            });
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send(projectBondTokenExchangeResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            mailArrived: getMailArrivedSync(playerId),
        }));
    });

    fastify.post("/get_bond_token_exchange_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number; api_count: number };

        const viewerId = body.viewer_id;
        if (isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body.",
        });

        const viewerIdSession = await getSession(viewerId.toString());
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id.",
        });

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!;
        const player = playerId !== null ? getPlayerSync(playerId) : null;
        if (player === null) return reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        });

        const entries = listBondTokenExchangeRuntimeSync(
            playerId,
            getGameTimeContext().virtualNowMs,
        );

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: projectBondTokenExchangeListResponse(entries),
        });
    });
};

export default routes;
