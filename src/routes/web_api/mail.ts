import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { getAllAccountsSync, getAccountPlayersSync, insertMailSync } from "../../data/wdfpData"
import characterData from "../../../assets/character.json"
import itemData from "../../../assets/item_data.json"

// Pre-built CDN validation sets
const CDN_CHAR_IDS: Set<number> = new Set(Object.keys(characterData).map(Number))
const CDN_ITEM_IDS: Set<number> = new Set(Object.keys(itemData).map(Number))

interface SendMailBody {
    type: string
    type_id?: string
    number: string
    subject?: string
    description?: string
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/send", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SendMailBody

        const mailType = parseInt(body.type || "0")
        const typeId = body.type_id ? parseInt(body.type_id) : null

        // Validate type_id fits in 32-bit signed integer (client Int limit)
        if (typeId !== null && (isNaN(typeId) || typeId > 2147483647 || typeId < 1)) {
            return reply.redirect("/mail?error=" + encodeURIComponent("附件 ID 无效（需为 1-2147483647 之间的整数）"))
        }

        // Validate type_id against CDN data
        if (typeId !== null) {
            if (mailType === 5 && !CDN_CHAR_IDS.has(typeId)) {
                return reply.redirect("/mail?error=" + encodeURIComponent(`角色 ID ${typeId} 不存在于 CDN 数据中`))
            }
            if (mailType === 1 && !CDN_ITEM_IDS.has(typeId)) {
                return reply.redirect("/mail?error=" + encodeURIComponent(`道具 ID ${typeId} 不存在于 CDN 数据中`))
            }
        }
        const count = parseInt(body.number || "1")
        const subject = body.subject && body.subject.trim() ? body.subject.trim() : null
        const desc = body.description && body.description.trim() ? body.description.trim() : null

        // types that require type_id: Item(1), Character(5), Equipment(6)
        if ((mailType === 1 || mailType === 5 || mailType === 6) && (typeId === null || isNaN(typeId))) {
            return reply.redirect("/mail?error=" + encodeURIComponent("此附件类型需要填写附件 ID"))
        }

        if (isNaN(count) || count < 1) {
            return reply.redirect("/mail?error=" + encodeURIComponent("数量必须大于 0"))
        }

        const accounts = getAllAccountsSync()
        const now = new Date().toISOString().replace("T", " ").substring(0, 19)
        let sentCount = 0

        for (const account of accounts) {
            const playerIds = getAccountPlayersSync(account.id)
            for (const playerId of playerIds) {
                try {
                    insertMailSync(playerId, {
                        reason_id: 0,
                        subject,
                        description: desc,
                        type: mailType,
                        type_id: typeId,
                        number: count,
                        receive_time: "0000-00-00 00:00:00",
                        create_time: now,
                        reward_period_limited: 0,
                        reward_limit_time: null,
                    })
                    sentCount++
                } catch {
                    // skip invalid players
                }
            }
        }

        return reply.redirect("/mail?ok=" + encodeURIComponent(`已向 ${sentCount} 个角色发送邮件`))
    })
}

export default routes
