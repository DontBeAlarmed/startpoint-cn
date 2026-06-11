import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deserializePlayerData, getClientSerializedData } from "../../data/utils";
import { getAllPlayersSync, replacePlayerDataSync, getPlayerSync, updatePlayerSync, getPlayerCharactersSync, getPlayerItemsSync, getPlayerEquipmentListSync, insertPlayerCharacterSync, insertDefaultPlayerCharacterSync, updatePlayerItemSync, getDb } from "../../data/wdfpData";

interface SaveQuery {
    id: string | undefined
}

interface GetPlayersQuery {
    page: string | undefined,
    perPage: string | undefined
}

const defaultPerPage = 25

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
        const { page, perPage } = request.query as GetPlayersQuery
        const parsedPage = page === undefined ? 0 : Number.parseInt(page)
        const parsedPerPage = perPage === undefined ? defaultPerPage : Number.parseInt(perPage)
        if (isNaN(parsedPage) || isNaN(parsedPerPage)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid query parameters."
        })

        const players = getAllPlayersSync(parsedPage * parsedPerPage, Math.min(defaultPerPage, parsedPerPage))
        return reply.status(200).send(players)
    })

    fastify.get("/save", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");

        const data = getClientSerializedData(playerId, { serializeRushEventData: true })
        if (data === null) return reply.redirect("/player");

        reply.header("content-disposition", "attachment; save.json")
        reply.type('application/json').send(data)
    })

    fastify.post("/save", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");
        
        try {
            const file = await (request as any).file()
            if (file === undefined) return reply.redirect(`/player/${id}`);

            const text = (await file.toBuffer()).toString('utf-8')
            const json = JSON.parse(text)

            const saveData = json['data'] === undefined ? json : json['data']
            const parsedData = deserializePlayerData(playerId, saveData)
            replacePlayerDataSync(parsedData)
        } catch (error) {
            return reply.redirect(`/player/${id}?error=${error}`);
        }
        return reply.redirect(`/player/${id}`);
    })

    // ====== New: Inline edit endpoints ======

    // Edit single field
    fastify.patch("/:id/field", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(404).send({ error: "Player not found" })

        const body = request.body as Record<string, any> || {}
        const field = body.field
        const rawValue = body.value
        if (!field || rawValue === undefined) return reply.status(400).send({ error: "Missing field or value" })

        // Convert value based on field type
        let value: any = rawValue
        const stringFields = ['name', 'comment']
        const booleanFields = ['enableAuto3x', 'tutorialSkipFlag']
        const nullFields = ['tutorialSkipFlag', 'tutorialStep']

        if (booleanFields.includes(field)) {
            value = rawValue === true || rawValue === 'true' || rawValue === '1'
        } else if (nullFields.includes(field) && (rawValue === '' || rawValue === 'null' || rawValue === null)) {
            value = null
        } else if (!stringFields.includes(field)) {
            value = Number(rawValue)
            if (isNaN(value)) return reply.status(400).send({ error: `Invalid number for ${field}` })
        }

        try {
            updatePlayerSync({ id: playerId, [field]: value })
            return reply.status(200).send({ ok: true, field, value })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Add character
    fastify.post("/:id/character", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })

        const body = request.body as Record<string, any> || {}
        const code = Number(body.code || body.character_id)
        if (isNaN(code)) return reply.status(400).send({ error: "Missing code (business code)" })

        try {
            insertDefaultPlayerCharacterSync(playerId, code)
            return reply.status(200).send({ ok: true, code })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Delete character
    fastify.delete("/:id/character/:code", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, code } = request.params as { id: string, code: string }
        const playerId = Number(id)
        const charCode = Number(code)
        if (isNaN(playerId) || isNaN(charCode)) return reply.status(400).send({ error: "Invalid params" })

        try {
        const db = getDb();
        // 1. Delete character data
        db.prepare(`DELETE FROM players_characters WHERE player_id = ? AND id = ?`).run(playerId, charCode)
        db.prepare(`DELETE FROM players_characters_bond_tokens WHERE player_id = ? AND character_id = ?`).run(playerId, charCode)
        db.prepare(`DELETE FROM players_characters_mana_nodes WHERE player_id = ? AND character_id = ?`).run(playerId, charCode)
        // 2. Clear all party references to this character
        for (const col of ['character_id_1', 'character_id_2', 'character_id_3',
                            'unison_character_1', 'unison_character_2', 'unison_character_3']) {
            db.prepare(`UPDATE players_parties SET ${col} = NULL WHERE player_id = ? AND ${col} = ?`).run(playerId, charCode)
        }
        return reply.status(200).send({ ok: true })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Add/set item
    fastify.post("/:id/item", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })

        const body = request.body as Record<string, any> || {}
        const itemId = Number(body.id || body.itemId)
        const count = Number(body.count || 1)
        if (isNaN(itemId) || isNaN(count)) return reply.status(400).send({ error: "Missing id or count" })

        try {
            updatePlayerItemSync(playerId, itemId, count)
            return reply.status(200).send({ ok: true, itemId, count })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Delete item
    fastify.delete("/:id/item/:itemId", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, itemId } = request.params as { id: string, itemId: string }
        const playerId = Number(id)
        const iid = Number(itemId)
        if (isNaN(playerId) || isNaN(iid)) return reply.status(400).send({ error: "Invalid params" })

        try {
            const db = getDb();
        db.prepare(`DELETE FROM players_items WHERE player_id = ? AND id = ?`).run(playerId, iid)
            return reply.status(200).send({ ok: true })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Delete single quest progress record
    fastify.delete("/:id/quest_progress/:section/:quest_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, section, quest_id } = request.params as { id: string, section: string, quest_id: string }
        const playerId = Number(id)
        const sec = Number(section)
        const qid = Number(quest_id)
        if (isNaN(playerId) || isNaN(sec) || isNaN(qid)) return reply.status(400).send({ error: "Invalid params" })
        try {
            const db = getDb()
            db.prepare(`DELETE FROM players_quest_progress WHERE player_id = ? AND section = ? AND quest_id = ?`).run(playerId, sec, qid)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })

    // Delete all quest progress for a player
    fastify.delete("/:id/quest_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid params" })
        try {
            const db = getDb()
            db.prepare(`DELETE FROM players_quest_progress WHERE player_id = ?`).run(playerId)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })

    // Delete single drawn quest record
    fastify.delete("/:id/drawn_quest/:category/:quest_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, category, quest_id } = request.params as { id: string, category: string, quest_id: string }
        const playerId = Number(id)
        const cat = Number(category)
        const qid = Number(quest_id)
        if (isNaN(playerId) || isNaN(cat) || isNaN(qid)) return reply.status(400).send({ error: "Invalid params" })
        try {
            const db = getDb()
            db.prepare(`DELETE FROM players_drawn_quests WHERE player_id = ? AND category_id = ? AND quest_id = ?`).run(playerId, cat, qid)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })

    // Delete all drawn quests for a player
    fastify.delete("/:id/drawn_quest", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid params" })
        try {
            const db = getDb()
            db.prepare(`DELETE FROM players_drawn_quests WHERE player_id = ?`).run(playerId)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })
}

export default routes;
