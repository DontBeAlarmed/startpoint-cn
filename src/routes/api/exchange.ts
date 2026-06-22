import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerSync,
    getSession,
    updatePlayerSync,
    playerOwnsCharacterSync,
    playerOwnsEquipmentSync,
} from "../../data/wdfpData";
import { givePlayerItemSync } from "../../data/domains/item";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import starCrumbExchange from "../../../assets/star_crumb_exchange.json";
import starCrumbExchangeCost from "../../../assets/star_crumb_exchange_cost.json";

interface ExchangeBody {
    viewer_id: number;
    exchange_id: number;
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

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!;
        const player = playerId !== null ? getPlayerSync(playerId) : null;
        if (player === null) return reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        });

        // star_crumb_exchange.json: { exchange_id: [["kind","id","desc","start","end","limited","comeback","stars","rarity"]] }
        const exchangeList = (starCrumbExchange as Record<string, string[][]>)[String(exchangeId)];
        if (!exchangeList || !exchangeList[0]) return reply.status(400).send({
            error: "Bad Request",
            message: `Exchange item with id ${exchangeId} does not exist.`,
        });

        const entry = exchangeList[0];
        const kind = Number(entry[0]); // 0=Character, 1=Item, 2=Equipment
        const targetId = Number(entry[1]);
        const rarity = Number(entry[8]); // 4 or 5

        // cost table: { "0": [["300","600"]], "1": [["300","600"]], "2": [["200","400"]] }
        const costTable = starCrumbExchangeCost as Record<string, string[][]>;
        const costEntry = costTable[String(kind)];
        if (!costEntry || !costEntry[0]) return reply.status(500).send({
            error: "Internal Server Error",
            message: `No cost data for kind ${kind}.`,
        });

        const costIdx = rarity === 5 ? 1 : 0;
        const cost = Number(costEntry[0][costIdx]);
        if (isNaN(cost) || cost <= 0) return reply.status(500).send({
            error: "Internal Server Error",
            message: `Invalid cost for kind=${kind} rarity=${rarity}.`,
        });

        console.log(`[exchange:star_crumb] player=${playerId} exch=${exchangeId} kind=${kind} id=${targetId} rarity=${rarity} cost=${cost}`);

        // Validate balance
        if (player.starCrumb < cost) return reply.status(400).send({
            error: "Bad Request",
            message: "Not enough star_crumb.",
        });

        // Validate ownership
        if (kind === 0 && playerOwnsCharacterSync(playerId, targetId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Character already owned." });
        }
        if (kind === 2 && playerOwnsEquipmentSync(playerId, targetId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Equipment already owned." });
        }

        // Deduct
        const newStarCrumb = player.starCrumb - cost;
        updatePlayerSync({ id: playerId, starCrumb: newStarCrumb });

        // Give reward
        const characterList: any[] = [];
        const itemList: Record<string, number> = {};
        const equipmentList: any[] = [];

        switch (kind) {
            case 0: { // Character
                const result = givePlayerCharacterSync(playerId, targetId);
                if (!result) {
                    updatePlayerSync({ id: playerId, starCrumb: player.starCrumb });
                    return reply.status(500).send({ error: "Internal Server Error", message: "Failed to give character." });
                }
                characterList.push(result.character);
                break;
            }
            case 1: { // Item
                const newCount = givePlayerItemSync(playerId, targetId, 1);
                itemList[String(targetId)] = newCount;
                break;
            }
            case 2: { // Equipment
                const result = givePlayerEquipmentSync(playerId, targetId, 1);
                if (!result) {
                    updatePlayerSync({ id: playerId, starCrumb: player.starCrumb });
                    return reply.status(500).send({ error: "Internal Server Error", message: "Failed to give equipment." });
                }
                equipmentList.push(result);
                break;
            }
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                user_info: { star_crumb: newStarCrumb },
                character_list: characterList,
                item_list: itemList,
                equipment_list: equipmentList,
                active_mission_list: null,
                mission_info: null,
                over_max: null,
                mail_arrived: false,
                config: null,
                user_daily_challenge_point_list: null,
                encyclopedia_info: null,
                fund_receive_list: null,
                monthly_charge_bonus_info: null,
                crazy_gacha_result_list: null,
            },
        });
    });
};

export default routes;
