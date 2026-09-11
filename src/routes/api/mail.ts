import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, RawPlayerMail, deleteExpiredPlayerMailsSync, deletePlayerMailsByIdsSync, getPlayerMailCountSync, getPlayerMailSync, getPlayerMailsByIdsSync, getPlayerMailsSync, isPlayerMailExpiredAt, receiveMailSync } from "../../data/domains/mail"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders } from "../../utils";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getDb } from "../../data/db";
import { getVirtualNow } from "../../runtime/time/game-time";
import {
    settleMailRewardsInTransactionOwnerSync,
    MailRewardCapacityError,
    UnsupportedMailAttachmentError,
} from "../../lib/mail-reward-grant";
import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../../lib/common-response/entities";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge";
import type { CommonResponseFragment } from "../../lib/common-response/model";
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow/common-response";
import type { PlannedItemOverflowDisposition } from "../../lib/item-overflow/disposition";

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

class MailNotAvailableError extends Error {
    constructor(public readonly resultCode: 2001 | 2002 | 2004) {
        super("Mail not available")
    }
}
const MAX_RECEIVE_ALL_MAIL_IDS = 500

function getMailAwakeInvalidatedFactKeys(
    mails: readonly RawPlayerMail[],
    autoSaleExpiredMailCount = 0,
) {
    return mails.some(mail => mail.type === MailType.FREE_MANA)
        || autoSaleExpiredMailCount > 0
        ? [{ kind: "player" as const }]
        : []
}

function unsupportedMailReply(reply: FastifyReply, error: unknown): FastifyReply | null {
    if (!(error instanceof UnsupportedMailAttachmentError)) return null
    return reply.status(400).send({ error: "Unsupported mail attachment", message: error.message })
}

function finalizeMailReceiveAwakePublicationWrites(
    playerId: number,
    mailId: number,
    mail: RawPlayerMail,
): void {
    if (receiveMailSync(playerId, mailId, mail) === null) {
        throw new Error(`Mail ${mailId} changed while it was being received.`)
    }
    if (deletePlayerMailsByIdsSync(playerId, [mailId]) !== 1) {
        throw new Error(`Mail ${mailId} could not be removed after receipt.`)
    }
}

function finalizeMailReceiveAllAwakePublicationWrites(
    playerId: number,
    validMailIds: readonly number[],
    mailMap: ReadonlyMap<number, RawPlayerMail>,
): number[] {
    const claimed: number[] = []
    for (const mailId of validMailIds) {
        if (receiveMailSync(playerId, mailId, mailMap.get(mailId)) !== null) {
            claimed.push(mailId)
            if (deletePlayerMailsByIdsSync(playerId, [mailId]) !== 1) {
                throw new Error(`Mail ${mailId} could not be removed after receipt.`)
            }
        }
    }
    if (claimed.length !== validMailIds.length) {
        throw new Error("Mail state changed while mails were being received.")
    }
    return claimed
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

        deleteExpiredPlayerMailsSync(playerId, getVirtualNow())
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
            const evaluationTime = getVirtualNow()
            // The client handles 2001/2002/2004 in MailReceiveRealRemote's
            // graceful channel (ReceiveErrorNoPresent/AlreadyReceive/
            // PeriodOutdated), so these stay HTTP 200 with a result code.
            const mail = getPlayerMailSync(playerId, mailId)
            if (!mail) throw new MailNotAvailableError(2001)
            if (mail.receive_time !== "0000-00-00 00:00:00") {
                throw new MailNotAvailableError(2002)
            }
            if (isPlayerMailExpiredAt(mail, getVirtualNow())) {
                deletePlayerMailsByIdsSync(playerId, [mail.id])
                throw new MailNotAvailableError(2004)
            }
            settlement = getDb().transaction(() => {
                const player = getPlayerSync(playerId)
                if (!player) throw new Error(`Mail player ${playerId} no longer exists.`)
                const reward = settleMailRewardsInTransactionOwnerSync(playerId, [mail], player, evaluationTime)
                finalizeMailReceiveAwakePublicationWrites(playerId, mailId, mail)
                return {
                    ...reward,
                    reconciledCharacterList: publishCharacterGrowthOwnerStateBestEffort(
                        playerId,
                        [],
                        [reward.characterList],
                        {
                            invalidatedFactKeys: getMailAwakeInvalidatedFactKeys(
                                [mail],
                                reward.autoSaleExpiredMailCount,
                            ),
                        },
                        "mail/receive",
                        new Date(getVirtualNow()),
                    ).characterList,
                }
            })()
        } catch (error) {
            if (error instanceof MailNotAvailableError) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: error.resultCode,
                    }),
                    data: {},
                })
            }
            if (error instanceof MailRewardCapacityError) return reply.status(400).send({
                error: "Mail reward cannot fit",
                message: error.message,
            })
            const unsupported = unsupportedMailReply(reply, error)
            if (unsupported !== null) return unsupported
            throw error
        }
        const { equipmentList, itemList, userInfo, reconciledCharacterList } = settlement

        const totalCount = getPlayerMailCountSync(playerId)
        const overMax = projectItemOverflowCommonResponse(
            settlement.itemOverflowDispositions ?? [],
        )
        const fragment: CommonResponseFragment = {
            mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
            ...(overMax.length > 0 ? { over_max: overMax } : {}),
            ...(reconciledCharacterList.length > 0
                ? {
                    character_list: reconciledCharacterList.map(
                        character => projectCharacterPatch(character),
                    ),
                }
                : {}),
            ...(equipmentList.length > 0
                ? {
                    equipment_list: equipmentList.map(
                        equipment => projectEquipmentEntity(equipment),
                    ),
                }
                : {}),
            ...(Object.keys(itemList).length > 0 ? { item_list: itemList } : {}),
            ...(Object.keys(userInfo).length > 0 ? { user_info: userInfo } : {}),
        }
        const responseData: Record<string, any> = {
            auto_sale_expired_mail: settlement.autoSaleExpiredMailCount > 0,
            dispose_expired_mail: false,
            total_count: totalCount,
            ...mergeCommonResponseFragments([fragment]),
        }

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
        if (!viewerId || isNaN(viewerId) || !mailIds || !Array.isArray(mailIds)
            || mailIds.length > MAX_RECEIVE_ALL_MAIL_IDS
            || mailIds.some(mailId => !Number.isSafeInteger(mailId) || mailId <= 0)) return reply.status(400).send({
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
            deletedCount: number
            outdatedCount: number
            blockedCount: number
            autoSaleExpiredMailCount: number
            claimed: number[]
            reconciledCharacterList: Record<string, unknown>[]
            equipmentList: any[]
            itemList: Record<string, number>
            userInfo: Record<string, any>
            itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
        }
        try {
            const evaluationTime = getVirtualNow()
            settlement = getDb().transaction(() => {
                const unreceivedMails = getPlayerMailsByIdsSync(playerId, uniqueMailIds, true)
                const expiredMails = unreceivedMails.filter(mail => (
                    isPlayerMailExpiredAt(mail, evaluationTime)
                ))
                const expiredMailIds = expiredMails.map(mail => mail.id)
                deletePlayerMailsByIdsSync(playerId, expiredMailIds)
                const expiredMailIdSet = new Set(expiredMailIds)
                const mailMap = new Map(unreceivedMails.map(mail => [mail.id, mail]))
                const validMails = uniqueMailIds
                    .map(mailId => mailMap.get(mailId))
                    .filter((mail): mail is RawPlayerMail => (
                        mail !== undefined && !expiredMailIdSet.has(mail.id)
                    ))
                let player = getPlayerSync(playerId)
                if (!player) throw new Error(`Mail player ${playerId} no longer exists.`)
                const claimed: number[] = []
                const claimedMails: RawPlayerMail[] = []
                const characters: Record<string, unknown>[] = []
                const equipment: any[] = []
                const itemList: Record<string, number> = {}
                const userInfo: Record<string, number> = {}
                let blockedCount = 0
                let autoSaleExpiredMailCount = 0
                const itemOverflowDispositions: PlannedItemOverflowDisposition[] = []
                for (const mail of validMails) {
                    try {
                        const mailSettlement = getDb().transaction(() => {
                            const reward = settleMailRewardsInTransactionOwnerSync(
                                playerId,
                                [mail],
                                player!,
                                evaluationTime,
                            )
                            return reward
                        })()
                        claimed.push(mail.id)
                        claimedMails.push(mail)
                        characters.push(...mailSettlement.characterList)
                        equipment.push(...mailSettlement.equipmentList)
                        Object.assign(itemList, mailSettlement.itemList)
                        Object.assign(userInfo, mailSettlement.userInfo)
                        autoSaleExpiredMailCount += mailSettlement.autoSaleExpiredMailCount
                        itemOverflowDispositions.push(...(
                            mailSettlement.itemOverflowDispositions ?? []
                        ))
                        player = mailSettlement.playerAfter
                    } catch (error) {
                        if (error instanceof MailRewardCapacityError) {
                            blockedCount++
                            continue
                        }
                        throw error
                    }
                }
                const finalized = finalizeMailReceiveAllAwakePublicationWrites(
                    playerId,
                    claimed,
                    mailMap,
                )
                if (finalized.length !== claimed.length) {
                    throw new Error("Mail state changed while mails were being received.")
                }
                return {
                    alreadyCount: uniqueMailIds.length
                        - claimed.length
                        - blockedCount
                        - expiredMailIds.length,
                    deletedCount: expiredMailIds.length,
                    outdatedCount: expiredMailIds.length,
                    blockedCount,
                    autoSaleExpiredMailCount,
                    claimed,
                    reconciledCharacterList: publishCharacterGrowthOwnerStateBestEffort(
                        playerId,
                        [],
                        [characters],
                        {
                            invalidatedFactKeys: getMailAwakeInvalidatedFactKeys(
                                claimedMails,
                                autoSaleExpiredMailCount,
                            ),
                        },
                        "mail/receive-all",
                        evaluationTime,
                    ).characterList,
                    equipmentList: equipment,
                    itemList,
                    userInfo,
                    itemOverflowDispositions: Object.freeze(itemOverflowDispositions),
                }
            })()
        } catch (error) {
            if (error instanceof MailRewardCapacityError) return reply.status(400).send({
                error: "Mail reward cannot fit",
                message: error.message,
            })
            const unsupported = unsupportedMailReply(reply, error)
            if (unsupported !== null) return unsupported
            throw error
        }
        const {
            alreadyCount,
            deletedCount,
            outdatedCount,
            blockedCount,
            autoSaleExpiredMailCount,
            claimed,
            reconciledCharacterList,
            equipmentList,
            itemList,
            userInfo,
            itemOverflowDispositions,
        } = settlement

        const overMax = projectItemOverflowCommonResponse(itemOverflowDispositions)
        const receiveAllFragment: CommonResponseFragment = {
            mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
            ...(reconciledCharacterList.length > 0
                ? {
                    character_list: reconciledCharacterList.map(
                        character => projectCharacterPatch(character),
                    ),
                }
                : {}),
            ...(equipmentList.length > 0
                ? {
                    equipment_list: equipmentList.map(
                        equipment => projectEquipmentEntity(equipment),
                    ),
                }
                : {}),
            ...(Object.keys(itemList).length > 0 ? { item_list: itemList } : {}),
            ...(Object.keys(userInfo).length > 0 ? { user_info: userInfo } : {}),
            ...(overMax.length > 0 ? { over_max: overMax } : {}),
        }
        const responseData: Record<string, any> = {
            already_mail_count: alreadyCount,
            auto_sale_expired_mail_count: autoSaleExpiredMailCount,
            deleted_mail_count: deletedCount,
            dispose_expired_mail_count: deletedCount,
            ex_boost_item_list: [],
            mail_ids: claimed,
            max_overed_mail_count: blockedCount,
            outdated_mail_count: outdatedCount,
            total_count: getPlayerMailCountSync(playerId),
            ...mergeCommonResponseFragments([receiveAllFragment]),
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: responseData
        })
    })
}

export default routes
