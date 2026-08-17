import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RawPlayerMail, getPlayerMailCountSync, getPlayerMailsSync, receiveMailSync } from "../../data/domains/mail"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import { getDb } from "../../data/db";
import {
    settleMailRewardsInTransactionOwnerSync,
    UnsupportedMailAttachmentError,
} from "../../lib/mail-reward-grant";

interface IndexBody {
    api_count: number
    viewer_id: number
    current_page: number
}

interface ReceiveBody {
    api_count: number
    viewer_id: number
    mail_id: number
}

interface ReceiveAllBody {
    api_count: number
    viewer_id: number
    mail_ids: number[]
}

class MailNotAvailableError extends Error {}

function unsupportedMailReply(reply: FastifyReply, error: unknown): FastifyReply | null {
    if (!(error instanceof UnsupportedMailAttachmentError)) return null
    return reply.status(400).send({ error: "Unsupported mail attachment", message: error.message })
}

function formatMailResponse(mail: RawPlayerMail) {
    return {
        id: mail.id,
        reason_id: mail.reason_id,
        subject: mail.subject,
        description: mail.description,
        type: mail.type,
        type_id: mail.type_id != null && mail.type_id > 2147483647 ? 0 : mail.type_id,
        number: mail.number,
        receive_time: mail.receive_time,
        create_time: mail.create_time,
        reward_period_limited: mail.reward_period_limited === 1,
        reward_limit_time: mail.reward_limit_time,
    }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer_id"
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer_id"
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account"
        })

        const page = body.current_page || 1
        const mails = getPlayerMailsSync(playerId, page, 100)
        const totalCount = getPlayerMailCountSync(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                mail: mails.map(formatMailResponse),
                total_count: totalCount,
            }
        })
    })

    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody
        const viewerId = body.viewer_id
        const mailId = body.mail_id
        if (!viewerId || isNaN(viewerId) || !mailId || isNaN(mailId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body"
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer_id"
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account"
        })

        let settlement: ReturnType<typeof settleMailRewardsInTransactionOwnerSync> & {
            reconciledCharacterList: Record<string, unknown>[]
        }
        try {
            settlement = getDb().transaction(() => {
                const mail = getPlayerMailsSync(playerId, 1, 1000, true)
                    .find(candidate => candidate.id === mailId)
                if (!mail) throw new MailNotAvailableError()
                const player = getPlayerSync(playerId)
                if (!player) throw new Error(`Mail player ${playerId} no longer exists.`)
                const reward = settleMailRewardsInTransactionOwnerSync(playerId, [mail], player)
                if (receiveMailSync(playerId, mailId) === null) {
                    throw new Error(`Mail ${mailId} changed while it was being received.`)
                }
                return {
                    ...reward,
                    reconciledCharacterList: reconcileAwakeUnlockCharacterList(playerId, reward.characterList),
                }
            })()
        } catch (error) {
            if (error instanceof MailNotAvailableError) return reply.status(400).send({
                error: "Bad Request",
                message: "Mail not found or already received"
            })
            const unsupported = unsupportedMailReply(reply, error)
            if (unsupported !== null) return unsupported
            throw error
        }
        const { equipmentList, itemList, userInfo, reconciledCharacterList } = settlement

        const totalCount = getPlayerMailCountSync(playerId)

        const responseData: Record<string, any> = {
            auto_sale_expired_mail: false,
            dispose_expired_mail: false,
            total_count: totalCount,
            mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
        }

        if (reconciledCharacterList.length > 0) responseData.character_list = reconciledCharacterList
        if (equipmentList.length > 0) responseData.equipment_list = equipmentList
        if (Object.keys(itemList).length > 0) responseData.item_list = itemList
        if (Object.keys(userInfo).length > 0) responseData.user_info = userInfo

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: responseData
        })
    })

    fastify.post("/receive_all", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveAllBody
        const viewerId = body.viewer_id
        const mailIds = body.mail_ids
        if (!viewerId || isNaN(viewerId) || !mailIds || !Array.isArray(mailIds)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body"
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer_id"
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account"
        })

        const uniqueMailIds = [...new Set(mailIds)]
        let settlement: {
            alreadyCount: number
            claimed: number[]
            reconciledCharacterList: Record<string, unknown>[]
            equipmentList: any[]
            itemList: Record<string, number>
            userInfo: Record<string, any>
        }
        try {
            settlement = getDb().transaction(() => {
                const unreceivedMails = getPlayerMailsSync(playerId, 1, 1000, true)
                const mailMap = new Map(unreceivedMails.map(mail => [mail.id, mail]))
                const validMailIds = uniqueMailIds.filter(mailId => mailMap.has(mailId))
                const validMails = validMailIds.map(mailId => mailMap.get(mailId)!)
                const player = getPlayerSync(playerId)
                if (!player) throw new Error(`Mail player ${playerId} no longer exists.`)
                const reward = settleMailRewardsInTransactionOwnerSync(playerId, validMails, player)
                const claimed = validMailIds.filter(mailId => receiveMailSync(playerId, mailId) !== null)
                if (claimed.length !== validMailIds.length) {
                    throw new Error("Mail state changed while mails were being received.")
                }
                return {
                    alreadyCount: uniqueMailIds.length - validMailIds.length,
                    claimed,
                    reconciledCharacterList: reconcileAwakeUnlockCharacterList(playerId, reward.characterList),
                    equipmentList: reward.equipmentList,
                    itemList: reward.itemList,
                    userInfo: reward.userInfo,
                }
            })()
        } catch (error) {
            const unsupported = unsupportedMailReply(reply, error)
            if (unsupported !== null) return unsupported
            throw error
        }
        const {
            alreadyCount,
            claimed,
            reconciledCharacterList,
            equipmentList,
            itemList,
            userInfo,
        } = settlement

        const responseData: Record<string, any> = {
            already_mail_count: alreadyCount,
            auto_sale_expired_mail_count: 0,
            deleted_mail_count: 0,
            dispose_expired_mail_count: 0,
            ex_boost_item_list: [],
            mail_ids: claimed,
            max_overed_mail_count: 0,
            outdated_mail_count: 0,
            total_count: getPlayerMailCountSync(playerId),
            mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
        }

        if (reconciledCharacterList.length > 0) responseData.character_list = reconciledCharacterList
        if (equipmentList.length > 0) responseData.equipment_list = equipmentList
        if (Object.keys(itemList).length > 0) responseData.item_list = itemList
        if (Object.keys(userInfo).length > 0) responseData.user_info = userInfo

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: responseData
        })
    })
}

export default routes
