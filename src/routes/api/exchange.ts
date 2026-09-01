import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { playerOwnsCharacterSync } from "../../data/domains/character";
import { playerOwnsEquipmentSync } from "../../data/domains/equipment";
import {
    getPlayerSync,
    updatePlayerSync,
} from "../../data/domains/player";
import { getSession } from "../../data/domains/session";
import { givePlayerItemSync } from "../../data/domains/item";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getMailArrivedSync } from "../../lib/mail-notification";
import bundledStarCrumbExchange from "../../../assets/star_crumb_exchange.json";
import bundledStarCrumbExchangeCost from "../../../assets/star_crumb_exchange_cost.json";
import { getDb } from "../../data/db";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";

interface ExchangeBody {
    viewer_id: number;
    exchange_id: number;
    api_count: number;
}

class StarCrumbExchangeError extends Error {
    constructor(
        public readonly statusCode: 400 | 500,
        message: string,
    ) {
        super(message)
        this.name = "StarCrumbExchangeError"
    }
}

interface StarCrumbExchangeSettlement {
    newStarCrumb: number
    characterList: Record<string, unknown>[]
    itemList: Record<string, number>
    equipmentList: any[]
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
        const starCrumbExchange = getRuntimeContentTableSync(
            "star_crumb_exchange.json",
            bundledStarCrumbExchange as Record<string, string[][]>,
        );
        const exchangeList = starCrumbExchange[String(exchangeId)];
        if (!exchangeList || !exchangeList[0]) return reply.status(400).send({
            error: "Bad Request",
            message: `Exchange item with id ${exchangeId} does not exist.`,
        });

        const entry = exchangeList[0];
        const kind = Number(entry[0]); // 0=Character, 1=Item, 2=Equipment
        const targetId = Number(entry[1]);
        const rarity = Number(entry[8]); // 4 or 5

        // cost table: { "0": [["300","600"]], "1": [["300","600"]], "2": [["200","400"]] }
        const costTable = getRuntimeContentTableSync(
            "star_crumb_exchange_cost.json",
            bundledStarCrumbExchangeCost as Record<string, string[][]>,
        );
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

        let settlement: StarCrumbExchangeSettlement
        try {
            settlement = getDb().transaction((): StarCrumbExchangeSettlement => {
                const currentPlayer = getPlayerSync(playerId)
                if (!currentPlayer) {
                    throw new StarCrumbExchangeError(500, "No players bound to account.")
                }
                if (currentPlayer.starCrumb < cost) {
                    throw new StarCrumbExchangeError(400, "Not enough star_crumb.")
                }
                if (kind === 0 && playerOwnsCharacterSync(playerId, targetId)) {
                    throw new StarCrumbExchangeError(400, "Character already owned.")
                }
                if (kind === 2 && playerOwnsEquipmentSync(playerId, targetId)) {
                    throw new StarCrumbExchangeError(400, "Equipment already owned.")
                }

                const newStarCrumb = currentPlayer.starCrumb - cost
                updatePlayerSync({ id: playerId, starCrumb: newStarCrumb })

                const characterList: Record<string, unknown>[] = []
                const itemList: Record<string, number> = {}
                const equipmentList: any[] = []

                switch (kind) {
                    case 0: {
                        const result = givePlayerCharacterSync(playerId, targetId)
                        if (!result) {
                            throw new StarCrumbExchangeError(500, "Failed to give character.")
                        }
                        if (result.character) characterList.push(result.character as Record<string, unknown>)
                        break
                    }
                    case 1: {
                        itemList[String(targetId)] = givePlayerItemSync(playerId, targetId, 1)
                        break
                    }
                    case 2: {
                        equipmentList.push(givePlayerEquipmentSync(playerId, targetId, 1))
                        break
                    }
                    default:
                        throw new StarCrumbExchangeError(500, `Unsupported exchange kind ${kind}.`)
                }

                return { newStarCrumb, characterList, itemList, equipmentList }
            })()
        } catch (error) {
            if (error instanceof StarCrumbExchangeError) {
                return reply.status(error.statusCode).send({
                    error: error.statusCode === 400 ? "Bad Request" : "Internal Server Error",
                    message: error.message,
                })
            }
            throw error
        }

        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            kind === 0 ? [targetId] : [],
            [settlement.characterList],
            {},
            "exchange/star_crumb",
        ).characterList

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                user_info: { star_crumb: settlement.newStarCrumb },
                character_list: characterList,
                item_list: settlement.itemList,
                equipment_list: settlement.equipmentList,
                active_mission_list: null,
                mission_info: null,
                over_max: null,
                mail_arrived: getMailArrivedSync(playerId),
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
