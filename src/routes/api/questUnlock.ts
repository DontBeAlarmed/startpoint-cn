import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestFromCategorySync } from "../../lib/assets";
import { generateDataHeaders } from "../../utils";
import bundledQuestUnlockCosts from "../../../assets/quest_unlock_costs.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";

interface UnlockBody {
    category: number
    quest_id: number
    viewer_id: number
    api_count: number
}

type UnlockTransactionResult =
    | { ok: true, itemList: Record<string, number> }
    | { ok: false, message: string }

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/unlock", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UnlockBody

        const viewerId = body.viewer_id
        const category = body.category
        const questId = body.quest_id

        if (isNaN(viewerId) || isNaN(category) || isNaN(questId)) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid viewer id."
            })
        }

        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": "No player bound to account."
            })
        }

        const player = getPlayerSync(playerId)
        if (player === null) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": "No player data."
            })
        }

        // Look up quest data
        const questData = getQuestFromCategorySync(category, questId)
        if (questData === null) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest not found."
            })
        }

        const unlockCost = getRuntimeContentTableSync(
            "quest_unlock_costs.json",
            bundledQuestUnlockCosts as Record<string, { itemIds: number[], itemCounts: number[] }>,
        )[String(questId)]
        if (!unlockCost || unlockCost.itemIds.length === 0) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest does not use Once unlock items."
            })
        }

        const result = getDb().transaction((): UnlockTransactionResult => {
            const progress = getPlayerQuestProgressSync(playerId)
            const sectionProg = progress[String(category)] ?? []
            const existing = sectionProg.find(entry => entry.questId === questId)
            if (existing?.unlocked) {
                return { ok: false, message: "Quest already unlocked." }
            }

            const itemCosts = new Map<number, number>()
            for (let i = 0; i < unlockCost.itemIds.length; i++) {
                const itemId = unlockCost.itemIds[i]
                const cost = unlockCost.itemCounts[i] ?? 1
                itemCosts.set(itemId, (itemCosts.get(itemId) ?? 0) + cost)
            }

            const currentItemCounts = new Map<number, number>()
            for (const [itemId, cost] of itemCosts) {
                const current = getPlayerItemSync(playerId, itemId) ?? 0
                if (current < cost) {
                    return {
                        ok: false,
                        message: `Not enough of item ${itemId} to unlock quest.`,
                    }
                }
                currentItemCounts.set(itemId, current)
            }

            const updatedItems: Record<string, number> = {}
            for (const [itemId, cost] of itemCosts) {
                const afterCount = (currentItemCounts.get(itemId) ?? 0) - cost
                updatePlayerItemSync(playerId, itemId, afterCount)
                updatedItems[String(itemId)] = afterCount
            }

            if (existing) {
                updatePlayerQuestProgressSync(playerId, category, { questId, unlocked: true })
            } else {
                insertPlayerQuestProgressSync(playerId, category, { questId, finished: false, unlocked: true })
            }
            return { ok: true, itemList: updatedItems }
        })()
        if (!result.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "item_list": result.itemList,
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })
}

export default routes
