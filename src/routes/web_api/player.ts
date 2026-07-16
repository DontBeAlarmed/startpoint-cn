import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getMergedPlayerDataSync, reviveMergedPlayerDates } from "../../data/utils";
import { validatePlayerField, VALID_CHARACTER_IDS, VALID_ITEM_IDS, MAX_INT } from "./validation";
import { wantsJson } from "./http";
import { dailyResetPlayerDataSync, getAllPlayersSync, getDefaultPlayerPartyGroupsSync, getPlayerDailyChallengePointListSync, getPlayerSync, insertPlayerDailyChallengePointListSync, replacePlayerDataSync, updatePlayerDailyChallengePointSync, updatePlayerSync } from "../../data/domains/player"
import { deleteAllPlayerMailSync } from "../../data/domains/mail"
import { getDb } from "../../data/db"
import { getPlayerCharactersSync, insertDefaultPlayerCharacterSync, insertPlayerCharacterSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerItemsSync, setPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerQuestProgressSync, getPlayerDrawnQuestsSync } from "../../data/domains/quest"
import { insertPlayerPartyGroupListSync } from "../../data/domains/party"
import { PartyCategory } from "../../data/types";
import { takeSnapshot } from "../../lib/mission/snapshot";
import { getServerDate } from "../../utils";
import dailyChallengePointLookup from "../../../assets/daily_challenge_point_lookup.json";

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

    fastify.get("/:id/detail", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(404).send({ error: "Player not found" })

        const characters = getPlayerCharactersSync(playerId)
        const charList = Object.entries(characters)
            .map(([code, char]) => ({
                code: Number(code),
                joinTime: char.joinTime.toISOString(),
                entryCount: char.entryCount,
                evolutionLevel: char.evolutionLevel,
                overLimitStep: char.overLimitStep,
                exp: char.exp,
                stack: char.stack,
                manaBoardIndex: char.manaBoardIndex,
            }))
            .sort((a, b) => new Date(b.joinTime).getTime() - new Date(a.joinTime).getTime())

        const items = getPlayerItemsSync(playerId)
        const itemList = Object.entries(items).map(([id, count]) => ({ id: Number(id), count }))

        const equipment = getPlayerEquipmentListSync(playerId)
        const equipList = Object.entries(equipment).map(([id, eq]) => ({
            id: Number(id),
            level: eq.level,
            enhancementLevel: eq.enhancementLevel,
        }))

        const questProgress = getPlayerQuestProgressSync(playerId)
        const questList: { section: number; questId: number; finished: boolean; highScore: number | null; clearRank: number | null; bestElapsedTimeMs: number | null }[] = []
        for (const [section, quests] of Object.entries(questProgress)) {
            for (const qp of quests) {
                questList.push({
                    section: Number(section),
                    questId: qp.questId,
                    finished: qp.finished,
                    highScore: qp.highScore ?? null,
                    clearRank: qp.clearRank ?? null,
                    bestElapsedTimeMs: qp.bestElapsedTimeMs ?? null,
                })
            }
        }

        const drawnQuests = getPlayerDrawnQuestsSync(playerId)

        return reply.send({
            player: {
                id: player.id,
                name: player.name,
                comment: player.comment,
                stamina: player.stamina,
                boostPoint: player.boostPoint,
                bossBoostPoint: player.bossBoostPoint,
                vmoney: player.vmoney,
                freeVmoney: player.freeVmoney,
                freeMana: player.freeMana,
                paidMana: player.paidMana,
                rankPoint: player.rankPoint,
                starCrumb: player.starCrumb,
                bondToken: player.bondToken,
                expPool: player.expPool,
                degreeId: player.degreeId,
                leaderCharacterId: player.leaderCharacterId,
                birth: player.birth,
                enableAuto3x: player.enableAuto3x,
                tutorialStep: player.tutorialStep,
                lastLoginTime: player.lastLoginTime.toISOString(),
                staminaHealTime: player.staminaHealTime.toISOString(),
                expPooledTime: player.expPooledTime.toISOString(),
                timeOffset: player.timeOffset ?? null,
            },
            characters: charList,
            items: itemList,
            equipment: equipList,
            questProgress: questList,
            drawnQuests: drawnQuests.map(dq => ({
                categoryId: dq.categoryId,
                questId: dq.questId,
                oddsId: dq.oddsId,
            })),
        })
    })

    fastify.get("/save", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");

        const data = getMergedPlayerDataSync(playerId)
        if (data === null) return reply.redirect("/player");

        const snapshot = {
            schema: "starpoint-cn-save",
            version: 1,
            exportedAt: new Date().toISOString(),
            playerId,
            data
        }
        reply.header("content-disposition", `attachment; filename="save_${playerId}.json"`)
        reply.type('application/json').send(JSON.stringify(snapshot))
    })

    fastify.post("/save", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        const json = wantsJson(request)
        // JSON 客户端返回结构化错误/成功；旧 SSR 页面保留 redirect
        const fail = (msg: string, code = 400) => json
            ? reply.status(code).send({ error: msg })
            : reply.redirect(`/player/${id}?error=${encodeURIComponent(msg)}`)
        if (isNaN(playerId)) return json ? reply.status(400).send({ error: "无效的玩家 ID" }) : reply.redirect("/player");

        try {
            const file = await (request as any).file()
            if (file === undefined) return fail("未选择文件")

            const text = (await file.toBuffer()).toString('utf-8')
            let parsed: any
            try {
                parsed = JSON.parse(text)
            } catch {
                return fail("文件不是有效的 JSON")
            }

            if (parsed === null || typeof parsed !== 'object' || parsed.schema !== 'starpoint-cn-save') {
                return fail("不是有效的存档快照（schema 不符，请使用本面板导出的存档）")
            }
            if (parsed.version !== 1) {
                return fail(`不支持的存档版本：${parsed.version}`)
            }
            const data = parsed.data
            if (!data || typeof data !== 'object' || !data.player) {
                return fail("存档数据缺失 player 字段")
            }

            reviveMergedPlayerDates(data)
            data.player.id = playerId
            replacePlayerDataSync(data)
        } catch (error: any) {
            return fail(`恢复失败：${error?.message ?? error}`, 500)
        }
        if (json) return reply.status(200).send({ ok: true, playerId })
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

        const result = validatePlayerField(field, rawValue)
        if (!result.ok) return reply.status(400).send({ error: result.error })
        const value = result.value

        // Auto-sync related time fields
        const extra: Record<string, any> = {}
        if (field === 'stamina') {
            extra.staminaHealTime = new Date()
        }
        if (field === 'expPool') {
            extra.expPooledTime = new Date()
        }

        try {
            const updateData = { id: playerId, [field]: value, ...extra }
            updatePlayerSync(updateData)
            return reply.status(200).send({ ok: true, field, value })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Clear all EX boost data for all characters
    fastify.post("/:id/clear_ex_boost", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        getDb().prepare(`UPDATE players_characters SET ex_boost_status_id = NULL, ex_boost_ability_id_list = NULL WHERE player_id = ?`).run(playerId)
        if (wantsJson(request)) return reply.status(200).send({ ok: true })
        return reply.redirect(`/player/${playerId}#actions`)
    })

    // Reset parties to defaults
    fastify.post("/:id/reset_parties", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        getDb().prepare(`DELETE FROM players_parties WHERE player_id = ?`).run(playerId)
        getDb().prepare(`DELETE FROM players_party_groups WHERE player_id = ?`).run(playerId)
        insertPlayerPartyGroupListSync(playerId, getDefaultPlayerPartyGroupsSync(PartyCategory.NORMAL))
        if (wantsJson(request)) return reply.status(200).send({ ok: true })
        return reply.redirect(`/player/${playerId}#actions`)
    })

    // Clear all mails
    fastify.post("/:id/clear_mail", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        deleteAllPlayerMailSync(playerId)
        return reply.redirect(`/player/${playerId}#actions`)
    })

    // Clear receive history
    fastify.post("/:id/clear_receive_history", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        getDb().prepare(`DELETE FROM players_receive_history WHERE player_id = ?`).run(playerId)
        if (wantsJson(request)) return reply.status(200).send({ ok: true })
        return reply.redirect(`/player/${playerId}#actions`)
    })

    // Add character
    fastify.post("/:id/character", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })

        const body = request.body as Record<string, any> || {}
        const code = Number(body.code || body.character_id)
        if (isNaN(code)) return reply.status(400).send({ error: "Missing code (business code)" })
        if (!VALID_CHARACTER_IDS.has(code)) return reply.status(400).send({ error: `角色 ID ${code} 不存在于资源表中` })

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
        if (!VALID_ITEM_IDS.has(itemId)) return reply.status(400).send({ error: `道具 ID ${itemId} 不存在于资源表中` })
        if (count < 0 || count > MAX_INT) return reply.status(400).send({ error: `count 超出范围（需 0 ~ ${MAX_INT}）` })

        try {
            setPlayerItemSync(playerId, itemId, count)
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
    fastify.post("/:id/reset_challenge", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid params" })
        try {
            const entries = getPlayerDailyChallengePointListSync(playerId)
            const lookup = dailyChallengePointLookup as Record<string, { maxPoint: number }>
            if (entries.length === 0) {
                // No entries yet — create all 282 from CDN
                const defaults = Object.entries(lookup).map(([idStr, data]) => ({
                    id: Number(idStr),
                    point: data.maxPoint,
                    campaignList: [] as any[]
                }))
                insertPlayerDailyChallengePointListSync(playerId, defaults)
                return reply.status(200).send({ ok: true, count: defaults.length, created: true })
            }
            for (const entry of entries) {
                const maxPoint = lookup[String(entry.id)]?.maxPoint ?? entry.point
                updatePlayerDailyChallengePointSync(playerId, entry.id, maxPoint)
            }
            return reply.status(200).send({ ok: true, count: entries.length })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })

    // Clear mailbox (admin recovery for crash-causing illegal mail)
    fastify.delete("/:id/mail", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        if (!getPlayerSync(playerId)) return reply.status(404).send({ error: "Player not found" })
        try {
            const deleted = deleteAllPlayerMailSync(playerId)
            return reply.status(200).send({ ok: true, deleted })
        } catch (e: any) {
            return reply.status(500).send({ error: e.message })
        }
    })

    // Admin: force daily mission reset (snapshot + wipe cache)
    fastify.post("/:id/daily_reset", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        const player = getPlayerSync(playerId)
        if (!player) return reply.status(404).send({ error: "Player not found" })
        try {
            const questProgress = getPlayerQuestProgressSync(playerId)
            let totalClears = 0, ss = 0, s = 0, a = 0, b = 0
            for (const [, quests] of Object.entries(questProgress)) {
                for (const qp of quests) {
                    if (qp.finished) {
                        totalClears++
                        if (qp.clearRank === 6) ss++
                        else if (qp.clearRank === 5) s++
                        else if (qp.clearRank === 4) a++
                        else if (qp.clearRank === 3) b++
                    }
                }
            }
            takeSnapshot(playerId, 'daily', {
                questClears: totalClears, staminaUsed: player.totalStaminaUsed,
                rankSs: ss, rankS: s, rankA: a, rankB: b,
            })
            getDb().prepare(`DELETE FROM players_active_missions WHERE player_id = ?`).run(playerId)
            getDb().prepare(`DELETE FROM players_active_missions_stages WHERE player_id = ?`).run(playerId)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })

    // Admin: force weekly mission reset (snapshot + wipe cache)
    fastify.post("/:id/weekly_reset", async (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = Number((request.params as any).id)
        if (isNaN(playerId)) return reply.status(400).send({ error: "Invalid player ID" })
        const player = getPlayerSync(playerId)
        if (!player) return reply.status(404).send({ error: "Player not found" })
        try {
            const questProgress = getPlayerQuestProgressSync(playerId)
            let totalClears = 0, ss = 0, s = 0, a = 0, b = 0
            for (const [, quests] of Object.entries(questProgress)) {
                for (const qp of quests) {
                    if (qp.finished) {
                        totalClears++
                        if (qp.clearRank === 6) ss++
                        else if (qp.clearRank === 5) s++
                        else if (qp.clearRank === 4) a++
                        else if (qp.clearRank === 3) b++
                    }
                }
            }
            takeSnapshot(playerId, 'weekly', {
                questClears: totalClears, staminaUsed: player.totalStaminaUsed,
                rankSs: ss, rankS: s, rankA: a, rankB: b,
            })
            getDb().prepare(`DELETE FROM players_active_missions WHERE player_id = ?`).run(playerId)
            getDb().prepare(`DELETE FROM players_active_missions_stages WHERE player_id = ?`).run(playerId)
            return reply.status(200).send({ ok: true })
        } catch (e: any) { return reply.status(500).send({ error: e.message }) }
    })
}

export default routes;
