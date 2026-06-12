import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDefaultPlayerPartyGroupsSync } from "../../data/domains/player";
import { serializePartyGroupList } from "../../data/utils";
import { generateDataHeaders } from "../../utils";
import { PartyCategory } from "../../data/types";

interface EventIdBody {
    event_id: number,
    viewer_id: number,
    api_count: number
}

function buildRaidPartyGroupList(): any[] {
    const groups = getDefaultPlayerPartyGroupsSync(PartyCategory.NORMAL);
    const serialized = serializePartyGroupList(groups);
    const result: any[] = [];
    for (const [groupId, group] of Object.entries(serialized)) {
        const partyList: any[] = [];
        const list = (group as any).list || {};
        for (const [partyId, party] of Object.entries(list)) {
            const p = party as any;
            partyList.push({
                "party_id": parseInt(partyId),
                "party_name": p.name || "Party",
                "party_edited": p.edited || false,
                "character_ids": p.character_ids || [null, null, null],
                "unison_character_ids": p.unison_character_ids || [null, null, null],
                "equipment_ids": p.equipment_ids || [null, null, null],
                "ability_soul_ids": p.ability_soul_ids || [null, null, null],
                "options": p.options || { "allow_other_players_to_heal_me": true }
            });
        }
        result.push({
            "party_group_id": parseInt(groupId),
            "party_group_color_id": (group as any).color_id || 0,
            "party_list": partyList
        });
    }
    return result;
}

const routes = async (fastify: FastifyInstance) => {
    // ---- summary (entry point) ----
    fastify.post("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EventIdBody;
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "aggregated_time": null,
                "auto_start_point": 0,
                "kill_count_reward_data": {
                    "received_up_to": 0,
                    "reward_list": []
                },
                "quest_list": {},
                "raid_boss": {
                    "hp_percentage": 100,
                    "total_kill_count": 0
                }
            }
        });
    });

    // ---- get_boss ----
    fastify.post("/get_boss", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EventIdBody;
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "raid_boss": {
                    "hp_percentage": 100,
                    "total_kill_count": 0
                }
            }
        });
    });

    // ---- ranking_reward ----
    fastify.post("/ranking_reward", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EventIdBody;
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "reward_list": [],
                "status": 0
            }
        });
    });

    // ---- party (get event party groups) ----
    fastify.post("/party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const partyGroups = buildRaidPartyGroupList();

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_party_group_list": partyGroups
            }
        });
    });

    // ---- ranking ----
    fastify.post("/ranking", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            event_id?: number, quest_id?: number,
            page?: number, aggregated_time?: string,
            viewer_id: number, api_count: number
        };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "aggregated_time": "",
                "quest_list": {}
            }
        });
    });

    // ---- ranking/party (view other player's party) ----
    fastify.post("/ranking/party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            quest_id: number, aggregated_time: string, rank_number: number,
            viewer_id: number, api_count: number
        };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "raid_ranking_party": []
            }
        });
    });

    // ---- battle/start (TODO: multi-player co-op, stub for now) ----
    fastify.post("/battle/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            quest_id: number, party_group_id: number, play_id: string,
            use_auto_start_point: boolean, is_auto_start_mode: boolean,
            auto_start_times?: number,
            viewer_id: number, api_count: number
        };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });
};

export default routes;
