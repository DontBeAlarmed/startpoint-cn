import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, RawPlayerMail, getPlayerMailCountSync, getPlayerMailsSync, insertReceiveHistorySync, receiveAllMailsSync, receiveMailSync } from "../../data/domains/mail"
import { getPlayerItemSync, givePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import { givePlayerCharacterSync } from "../../lib/character";
import { getDb } from "../../data/db";

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

const SUPPORTED_MAIL_TYPES = new Set<number>([
    MailType.ITEM,
    MailType.PAID_VMONEY,
    MailType.FREE_VMONEY,
    MailType.CHARACTER,
    MailType.EQUIPMENT,
    MailType.STAR_CRUMB,
    MailType.FREE_MANA,
    MailType.EXP_POOL,
    MailType.BOND_TOKEN,
    MailType.BOSS_BOOST_POINT,
    MailType.BOOST_POINT,
    MailType.RANK_POINT,
])

class UnsupportedMailAttachmentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UnsupportedMailAttachmentError"
    }
}

function requireMailTypeId(mail: RawPlayerMail): number {
    if (!Number.isSafeInteger(mail.type_id) || (mail.type_id as number) <= 0) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has an invalid attachment ID.`)
    }
    return mail.type_id as number
}

function validateMailReward(mail: RawPlayerMail): void {
    if (!SUPPORTED_MAIL_TYPES.has(mail.type)) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has unsupported attachment type ${mail.type}.`)
    }
    if (!Number.isSafeInteger(mail.number) || mail.number <= 0) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has an invalid attachment amount.`)
    }
    if (mail.type === MailType.ITEM
        || mail.type === MailType.CHARACTER
        || mail.type === MailType.EQUIPMENT) {
        requireMailTypeId(mail)
    }
}

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

function applyMailReward(playerId: number, mail: RawPlayerMail): {
    characterList: any[]
    equipmentList: any[]
    itemList: Record<string, number>
    userInfo: Record<string, any>
} {
    const player = getPlayerSync(playerId)
    const characterList: any[] = []
    const equipmentList: any[] = []
    const itemList: Record<string, number> = {}
    const userInfo: Record<string, any> = {}

    if (!player) return { characterList, equipmentList, itemList, userInfo }

    validateMailReward(mail)

    switch (mail.type) {
        case MailType.ITEM: {
            const itemId = requireMailTypeId(mail)
            const newAmount = givePlayerItemSync(playerId, itemId, mail.number)
            itemList[String(itemId)] = newAmount
            break
        }
        case MailType.PAID_VMONEY: {
            const newVmoney = player.vmoney + mail.number
            updatePlayerSync({ id: playerId, vmoney: newVmoney })
            userInfo['vmoney'] = newVmoney
            break
        }
        case MailType.FREE_VMONEY: {
            const newFreeVmoney = player.freeVmoney + mail.number
            updatePlayerSync({ id: playerId, freeVmoney: newFreeVmoney })
            userInfo['free_vmoney'] = newFreeVmoney
            break
        }
        case MailType.CHARACTER: {
            const characterId = requireMailTypeId(mail)
            for (let count = 0; count < mail.number; count++) {
                const result = givePlayerCharacterSync(playerId, characterId)
                if (result === null) {
                    throw new UnsupportedMailAttachmentError(`Mail ${mail.id} references unknown character ${characterId}.`)
                }
                characterList.splice(0, characterList.length, result.character)
                if (result.item !== undefined) {
                    itemList[String(result.item.id)] = getPlayerItemSync(playerId, result.item.id) ?? 0
                }
            }
            break
        }
        case MailType.EQUIPMENT: {
            const equipmentId = requireMailTypeId(mail)
            const result = givePlayerEquipmentSync(playerId, equipmentId, mail.number)
            equipmentList.push(result)
            break
        }
        case MailType.STAR_CRUMB: {
            const newCrumb = player.starCrumb + mail.number
            updatePlayerSync({ id: playerId, starCrumb: newCrumb })
            userInfo['star_crumb'] = newCrumb
            break
        }
        case MailType.FREE_MANA: {
            const newMana = player.freeMana + mail.number
            updatePlayerSync({ id: playerId, freeMana: newMana, totalManaObtained: (player.totalManaObtained ?? 0) + mail.number })
            userInfo['free_mana'] = newMana
            break
        }
        case MailType.EXP_POOL: {
            const newExp = player.expPool + mail.number
            updatePlayerSync({ id: playerId, expPool: newExp })
            userInfo['exp_pool'] = newExp
            break
        }
        case MailType.BOND_TOKEN: {
            const newBond = player.bondToken + mail.number
            updatePlayerSync({ id: playerId, bondToken: newBond })
            userInfo['bond_token'] = newBond
            break
        }
        case MailType.BOSS_BOOST_POINT: {
            const newBoss = player.bossBoostPoint + mail.number
            updatePlayerSync({ id: playerId, bossBoostPoint: newBoss })
            userInfo['boss_boost_point'] = newBoss
            break
        }
        case MailType.BOOST_POINT: {
            const newBoost = player.boostPoint + mail.number
            updatePlayerSync({ id: playerId, boostPoint: newBoost })
            userInfo['boost_point'] = newBoost
            break
        }
        case MailType.RANK_POINT: {
            const newRank = player.rankPoint + mail.number
            updatePlayerSync({ id: playerId, rankPoint: newRank })
            userInfo['rank_point'] = newRank
            break
        }
        default:
            throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has unsupported attachment type ${mail.type}.`)
    }

    insertReceiveHistorySync(playerId, { type: mail.type, type_id: mail.type_id, number: mail.number })

    return { characterList, equipmentList, itemList, userInfo }
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

        // Read mail before claiming to get attachment info
        const mails = getPlayerMailsSync(playerId, 1, 1000, true)
        const mail = mails.find(m => m.id === mailId)
        if (!mail) return reply.status(400).send({
            error: "Bad Request",
            message: "Mail not found or already received"
        })

        let settlement: ReturnType<typeof applyMailReward> & { reconciledCharacterList: Record<string, unknown>[] }
        try {
            settlement = getDb().transaction(() => {
                const reward = applyMailReward(playerId, mail)
                if (receiveMailSync(playerId, mailId) === null) {
                    throw new Error(`Mail ${mailId} changed while it was being received.`)
                }
                return {
                    ...reward,
                    reconciledCharacterList: reconcileAwakeUnlockCharacterList(playerId, reward.characterList),
                }
            })()
        } catch (error) {
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
                const characterList: any[] = []
                const equipmentList: any[] = []
                const itemList: Record<string, number> = {}
                const userInfo: Record<string, any> = {}

                for (const mailId of validMailIds) {
                    const mail = mailMap.get(mailId)!
                    const reward = applyMailReward(playerId, mail)
                    characterList.push(...reward.characterList)
                    equipmentList.push(...reward.equipmentList)
                    Object.assign(itemList, reward.itemList)
                    Object.assign(userInfo, reward.userInfo)
                }

                const claimed = receiveAllMailsSync(playerId, validMailIds)
                if (claimed.length !== validMailIds.length) {
                    throw new Error("Mail state changed while mails were being received.")
                }
                return {
                    alreadyCount: uniqueMailIds.length - validMailIds.length,
                    claimed,
                    reconciledCharacterList: reconcileAwakeUnlockCharacterList(playerId, characterList),
                    equipmentList,
                    itemList,
                    userInfo,
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
