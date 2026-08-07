import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { getAllAccountsSync, getAccountPlayersSync, getAccountSync } from "../../data/domains/account"
import { insertMailSync } from "../../data/domains/mail"
import { getPlayerSync } from "../../data/domains/player"
import { wantsJson } from "./http"
import { getEquipmentIdsSync, getItemIdsSync } from "../../lib/assets"
import { isValidCharacterId } from "./validation"
import {
    ADMIN_MAIL_MAX_INT,
    parseAdminMailInteger,
    validateMailAttachment,
} from "../../lib/admin-mail-rules"

const VALID_MAIL_TYPES: Set<number> = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15])

interface SendMailBody {
    type: string
    type_id?: string
    number: string
    subject?: string
    description?: string
    // 可选定向发送：playerId（指定存档）优先于 accountId（指定账号）；均不传则群发全体
    accountId?: string
    playerId?: string
}

// 群发历史（内存，最近 MAX_HISTORY 条；服务重启后清空）
interface MailSendRecord {
    time: string
    type: number
    typeId: number | null
    number: number
    subject: string | null
    target: string
    sent: number
}
const MAX_HISTORY = 20
const sendHistory: MailSendRecord[] = []

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/send", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SendMailBody
        // 迁移期分流：SPA 返回 JSON，旧表单保留 redirect
        const json = wantsJson(request)
        const fail = (msg: string) => json
            ? reply.status(400).send({ error: msg })
            : reply.redirect("/mail?error=" + encodeURIComponent(msg))

        const parsedMailType = parseAdminMailInteger(body.type, "附件类型", { min: 1, max: ADMIN_MAIL_MAX_INT })
        if (!parsedMailType.ok || parsedMailType.value === null) {
            return fail(parsedMailType.ok ? "附件类型无效" : parsedMailType.error)
        }
        const mailType = parsedMailType.value
        if (!VALID_MAIL_TYPES.has(mailType)) {
            return fail(`无效的附件类型：${mailType}`)
        }

        const parsedTypeId = parseAdminMailInteger(body.type_id, "附件 ID", {
            min: 1,
            max: ADMIN_MAIL_MAX_INT,
            allowNull: true,
        })
        if (!parsedTypeId.ok) {
            return fail(parsedTypeId.error)
        }
        const typeId = parsedTypeId.value

        // Validate type_id against CDN data
        if (typeId !== null) {
            if (mailType === 5 && !isValidCharacterId(typeId)) {
                return fail(`角色 ID ${typeId} 不存在于 CDN 数据中`)
            }
            if (mailType === 1 && !getItemIdsSync().includes(typeId)) {
                return fail(`道具 ID ${typeId} 不存在于 CDN 数据中`)
            }
            if (mailType === 6 && !getEquipmentIdsSync().includes(typeId)) {
                return fail(`装备 ID ${typeId} 不存在于 CDN 数据中`)
            }
        }
        const parsedCount = parseAdminMailInteger(body.number || "1", "数量", {
            min: 1,
            max: ADMIN_MAIL_MAX_INT,
        })
        if (!parsedCount.ok || parsedCount.value === null) {
            return fail(parsedCount.ok ? "数量无效" : parsedCount.error)
        }
        const count = parsedCount.value
        const subject = body.subject && body.subject.trim() ? body.subject.trim() : null
        const desc = body.description && body.description.trim() ? body.description.trim() : null

        const attachmentValidation = validateMailAttachment({ mailType, typeId, count })
        if (!attachmentValidation.ok) {
            return fail(attachmentValidation.error)
        }
        if (subject !== null && subject.length > 64) {
            return fail("标题过长（最多 64 字符）")
        }
        if (desc !== null && desc.length > 512) {
            return fail("正文过长（最多 512 字符）")
        }

        // 发送对象解析：playerId（指定存档）> accountId（指定账号）> 全体存档
        // 旧 SSR 表单不带这两个参数，因此保持群发全体行为不变
        let targetPlayerIds: number[]
        let targetLabel: string
        const rawPlayerId = body.playerId?.trim()
        const rawAccountId = body.accountId?.trim()
        if (rawPlayerId) {
            const pid = parseInt(rawPlayerId)
            if (isNaN(pid) || pid < 1) {
                return fail("存档 ID 无效")
            }
            const player = getPlayerSync(pid)
            if (!player) {
                return fail(`存档 ${pid} 不存在`)
            }
            targetPlayerIds = [pid]
            targetLabel = `存档 #${pid}（${player.name}）`
        } else if (rawAccountId) {
            const aid = parseInt(rawAccountId)
            if (isNaN(aid) || aid < 1) {
                return fail("账号 ID 无效")
            }
            if (!getAccountSync(aid)) {
                return fail(`账号 ${aid} 不存在`)
            }
            targetPlayerIds = getAccountPlayersSync(aid)
            targetLabel = `账号 #${aid}`
        } else {
            targetPlayerIds = getAllAccountsSync().flatMap(account => getAccountPlayersSync(account.id))
            targetLabel = "全体"
        }

        const now = new Date().toISOString().replace("T", " ").substring(0, 19)
        let sentCount = 0

        for (const playerId of targetPlayerIds) {
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

        // 记录群发历史（最近 MAX_HISTORY 条）
        sendHistory.unshift({
            time: now,
            type: mailType,
            typeId,
            number: count,
            subject,
            target: targetLabel,
            sent: sentCount,
        })
        if (sendHistory.length > MAX_HISTORY) sendHistory.length = MAX_HISTORY

        if (json) return reply.send({ ok: true, sent: sentCount })
        return reply.redirect("/mail?ok=" + encodeURIComponent(`已向 ${sentCount} 个角色发送邮件`))
    })

    // 群发历史（内存），供 SPA 展示最近几次群发
    fastify.get("/history", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(sendHistory)
    })
}

export default routes
