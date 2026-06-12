import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, getSession, getPlayerMailsSync, getPlayerMailCountSync, receiveMailSync, receiveAllMailsSync, insertDefaultPlayerCharacterSync, updatePlayerSync, insertPlayerEquipmentSync, insertReceiveHistorySync, MailType, RawPlayerMail } from "../../data/wdfpData";
import { getPlayerItemSync, givePlayerItemSync } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { clientSerializeDate } from "../../data/utils";

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

function formatMailResponse(mail: RawPlayerMail) {
    return {
        id: mail.id,
        reason_id: mail.reason_id,
        subject: mail.subject,
        description: mail.description,
        type: mail.type,
        type_id: mail.type_id,
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

    switch (mail.type) {
        case MailType.ITEM: {
            if (mail.type_id === null) break
            const newAmount = givePlayerItemSync(playerId, mail.type_id, mail.number)
            itemList[String(mail.type_id)] = newAmount
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
            if (mail.type_id === null) break
            insertDefaultPlayerCharacterSync(playerId, mail.type_id)
            const now = clientSerializeDate(new Date())
            characterList.push({
                character_id: mail.type_id,
                entry_count: 1,
                join_time: now,
                update_time: now
            })
            break
        }
        case MailType.EQUIPMENT: {
            if (mail.type_id === null) break
            const now = new Date()
            insertPlayerEquipmentSync(playerId, mail.type_id, {
                enhancementLevel: 0,
                level: 1,
                protection: false,
                stack: mail.number,
            })
            equipmentList.push({
                equipment_id: mail.type_id,
                enhancement_level: 0,
                level: 1,
                protection: false,
                stack: mail.number,
            })
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
            updatePlayerSync({ id: playerId, freeMana: newMana })
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

        // Apply reward first
        const { characterList, equipmentList, itemList, userInfo } = applyMailReward(playerId, mail)

        // Then mark as received
        receiveMailSync(playerId, mailId)

        const totalCount = getPlayerMailCountSync(playerId)

        const responseData: Record<string, any> = {
            auto_sale_expired_mail: false,
            dispose_expired_mail: false,
            total_count: totalCount,
            mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
        }

        if (characterList.length > 0) responseData.character_list = characterList
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

        // Get all unreceived mails
        const unreceivedMails = getPlayerMailsSync(playerId, 1, 1000, true)
        const mailMap = new Map(unreceivedMails.map(m => [m.id, m]))

        const alreadyCount = mailIds.filter(id => !mailMap.has(id)).length
        const characterList: any[] = []
        const equipmentList: any[] = []
        const itemList: Record<string, number> = {}
        const userInfo: Record<string, any> = {}

        for (const mailId of mailIds) {
            const mail = mailMap.get(mailId)
            if (!mail) continue

            const { characterList: cl, equipmentList: el, itemList: il, userInfo: ui } = applyMailReward(playerId, mail)
            characterList.push(...cl)
            equipmentList.push(...el)
            Object.assign(itemList, il)
            Object.assign(userInfo, ui)
        }

        // Mark all as received
        const claimed = receiveAllMailsSync(playerId, mailIds.filter(id => mailMap.has(id)))

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

        if (characterList.length > 0) responseData.character_list = characterList
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
