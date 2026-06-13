import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, getSession, getPlayerPartyGroupListSync, insertPlayerPartyGroupListSync, getPlayerCarnivalEventRecordsSync } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDefaultPlayerPartyGroupsSync } from "../../data/domains/player";
import { serializePartyGroupList } from "../../data/utils";
import { generateDataHeaders } from "../../utils";
import { PartyCategory } from "../../data/types";

interface IndexBody {
    event_id: number,
    viewer_id: number,
    api_count: number
}

function buildCarnivalPartyGroupList(playerId: number): any[] {
    // 1. Try to get saved EVENT party groups
    let groups = getPlayerPartyGroupListSync(playerId, PartyCategory.EVENT)

    // 2. First time - create empty EVENT defaults (independent from NORMAL pool)
    if (Object.keys(groups).length === 0) {
        groups = getDefaultPlayerPartyGroupsSync(PartyCategory.EVENT)
        insertPlayerPartyGroupListSync(playerId, groups)
    }

    const serialized = serializePartyGroupList(groups);
    // Convert to array format the client expects
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
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody;

        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString());
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        });

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!;
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        });

        const partyGroups = buildCarnivalPartyGroupList(playerId);

        // Build records from DB
        const eventId = body.event_id
        const dbRecords = getPlayerCarnivalEventRecordsSync(playerId, eventId)
        const records = dbRecords.map(r => ({
            folder_id: r.folderId,
            best_score: r.bestScore,
            previous_score: r.previousScore,
            previous_character_ids: r.previousCharacterIds ?? [null, null, null],
            previous_unison_character_ids: r.previousUnisonCharacterIds ?? [null, null, null],
        }))
        console.log(`[CARNIVAL] response records: ${JSON.stringify(records)}`)

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "records": records,
                "user_party_group_list": partyGroups
            }
        });
    });

    fastify.post("/get_party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, api_count: number };

        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString());
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        });

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!;
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        });

        const partyGroups = buildCarnivalPartyGroupList(playerId);

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_party_group_list": partyGroups
            }
        });
    });
};

export default routes;
