// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../../data/db";
import { getAccountPlayers } from "../../data/domains/account"
import { deletePlayerBoxGachaDrawnRewardsSync, getPlayerBoxGachaDrawnRewardsSync, getPlayerBoxGachaSync, insertPlayerBoxGachaDrawnRewardSync, insertPlayerBoxGachaSync, updatePlayerBoxGachaDrawnRewardSync, updatePlayerBoxGachaSync } from "../../data/domains/boxGacha"
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { playerOwnsEquipmentSync, updatePlayerEquipmentSync } from "../../data/domains/equipment"
import { updatePlayerPartyGroupSync } from "../../data/domains/party"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getBoxGachaSync } from "../../lib/assets";
import { parseBoxGachaResetRequest, sendBoxGachaResultCode } from "../../lib/box-gacha-protocol";
import { BoxGachaInvalidPeriodError, BoxGachaResetError, resetBoxGachaSync, validateBoxGachaPeriod } from "../../lib/box-gacha-reset";
import { drawBoxGachaSync, rewardPlayerBoxGachaResultSync } from "../../lib/gacha";
import { publishAwakeCharacterListBestEffort } from "../../lib/mission/awake-best-effort-context";
import { BoxGachaBoxes } from "../../lib/types";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time";

interface GetBoxListBody {
    box_gacha_id: number
    viewer_id: number
    api_count: number
}

interface ExecBody {
    stop_on_featured_rewards: boolean,
    box_gacha_id: number,
    box_id: number,
    api_count: number,
    viewer_id: number,
    number: number
}

interface CloseBody {
    box_gacha_id: number,
    box_id: number,
    viewer_id: number,
    api_count: number
}

class BoxGachaExecError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BoxGachaExecError"
    }
}

/**
 * Returns all of a box gacha's box statuses serialized for the client.
 * 
 * @param playerId The ID of the player.
 * @param boxGachaId The ID of the box gacha.
 * @param boxes A record of boxes to get the data of.
 * @param skipBoxId The ID of the box id to skip.
 */
function getAllBoxList(
    playerId: number,
    boxGachaId: number,
    boxes: BoxGachaBoxes,
    skipBoxId?: number
): Object[] {
    const boxInfo: Object[] = []
    for (const [boxId, _] of Object.entries(boxes)) {
        // get drawn rewards
        const parsedBoxId = Number(boxId)
        if (parsedBoxId !== skipBoxId) {
            const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, parsedBoxId)

            const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, parsedBoxId)

            boxInfo.push({
                "box_id": parsedBoxId,
                "reset_times": playerBoxData?.resetTimes ?? 0,
                "all_drawn_reward_list": playerDrawnRewards.map(reward => {
                    return {
                        "reward_id": reward.id,
                        "number": reward.number
                    }
                }),
                "coming_next_reward_list": [],
                "is_closed": playerBoxData?.isClosed ?? false
            })
        }
    }
    return boxInfo
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/reset", async (request: FastifyRequest, reply: FastifyReply) => {
        const resetRequest = parseBoxGachaResetRequest(request.body)
        if (resetRequest === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const { viewerId, boxGachaId, boxId } = resetRequest

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const boxGachaData = getBoxGachaSync(boxGachaId)
        const settings = boxGachaData?.boxSettings[boxId]
        const availableCount = boxGachaData?.availableCounts[boxId]
        if (
            boxGachaData === null
            || settings === undefined
            || availableCount === undefined
        ) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha or box id."
        })

        try {
            resetBoxGachaSync({
                playerId,
                boxGachaId,
                boxId,
                availableCount,
                settings,
                nowMs: getServerTime() * 1000,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getBox: getPlayerBoxGachaSync,
                updateBox: updatePlayerBoxGachaSync,
                deleteDrawnRewards: deletePlayerBoxGachaDrawnRewardsSync,
            })
        } catch (error) {
            if (error instanceof BoxGachaInvalidPeriodError) {
                return sendBoxGachaResultCode(reply, viewerId, error.errorCode)
            }
            if (error instanceof BoxGachaResetError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes)
            }
        })
    })

    fastify.post("/close", async (request: FastifyRequest, reply: FastifyReply) => {

        const body = request.body as CloseBody

        const viewerId = body.viewer_id
        const boxGachaId = body.box_gacha_id
        const boxId = body.box_id
        if (isNaN(viewerId) || isNaN(boxGachaId) || isNaN(boxId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!

        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get box asset data.
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        // get the box's data.
        const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, boxId)
        if (playerBoxData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Box doesn't exist"
        })

        // check if the box is already closed
        if (playerBoxData.isClosed) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Box is already closed."
        })

        // set box to be closed
        updatePlayerBoxGachaSync(playerId, boxGachaId, {
            boxId: boxId,
            isClosed: true
        })

        // get all boxes
        const allBoxDataList = getAllBoxList(playerId, boxGachaId, boxGachaData.boxes, boxId);

        // add box that we just closed to all box data.
        const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)
        allBoxDataList.push({
            "box_id": boxId,
            "reset_times": playerBoxData?.resetTimes ?? 0,
            "all_drawn_reward_list": playerDrawnRewards.map(reward => {
                return {
                    "reward_id": reward.id,
                    "number": reward.number
                }
            }),
            "coming_next_reward_list": [],
            "is_closed": true
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes)
            }
        })
    })

    fastify.post("/exec", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExecBody

        const viewerId = body.viewer_id
        const boxGachaId = body.box_gacha_id
        const boxId = body.box_id
        const pullCount = body.number
        const stopOnFeaturedRewards = body.stop_on_featured_rewards
        console.log(`[BOX] exec: boxGachaId=${boxGachaId} boxId=${boxId} pullCount=${pullCount}`)
        if (
            !Number.isSafeInteger(viewerId)
            || viewerId <= 0
            || !Number.isSafeInteger(boxGachaId)
            || boxGachaId <= 0
            || !Number.isSafeInteger(boxId)
            || boxId <= 0
            || !Number.isSafeInteger(pullCount)
            || pullCount <= 0
            || typeof stopOnFeaturedRewards !== "boolean"
        ) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get box gacha data
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        const boxRewards = boxGachaData.boxes[boxId]
        const availableCount = boxGachaData.availableCounts[boxId]
        const settings = boxGachaData.boxSettings[boxId]
        if (boxRewards === undefined || availableCount === undefined || settings === undefined) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid box ID."
            })
        }
        try {
            validateBoxGachaPeriod(settings, getServerTime() * 1000)
        } catch (error) {
            if (error instanceof BoxGachaInvalidPeriodError) {
                return sendBoxGachaResultCode(reply, viewerId, error.errorCode)
            }
            throw error
        }

        const pullCurrencyId = boxGachaData.redeemItemId
        let settlement!: {
            player: NonNullable<ReturnType<typeof getPlayerSync>>
            playerBoxData: ReturnType<typeof getPlayerBoxGachaSync>
            drawnRewards: ReturnType<typeof drawBoxGachaSync>["rewards"]
            rewardResult: ReturnType<typeof rewardPlayerBoxGachaResultSync>
            newPullCurrency: number
            remainingDrawsNumber: number
            shouldClose: boolean
        }
        try {
            settlement = getDb().transaction(() => {
                const player = getPlayerSync(playerId)
                if (player === null) throw new Error("Player disappeared during box gacha exec.")

                const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, boxId)
                if (playerBoxData?.isClosed) throw new BoxGachaExecError("Box is closed.")
                if (settings.requiredBoxId !== null) {
                    const requiredBox = getPlayerBoxGachaSync(
                        playerId,
                        boxGachaId,
                        settings.requiredBoxId,
                    )
                    if (!requiredBox || (!requiredBox.isClosed && requiredBox.remainingNumber > 0)) {
                        throw new BoxGachaExecError("Box is locked.")
                    }
                }

                const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)
                const existingDrawCount = playerDrawnRewards.reduce(
                    (sum, reward) => sum + reward.number,
                    0,
                )
                const remainingBefore = availableCount - existingDrawCount
                if (remainingBefore < 0) throw new Error("Box gacha drawn history exceeds inventory.")
                if (pullCount > remainingBefore) {
                    throw new BoxGachaExecError("Requested draw count exceeds remaining inventory.")
                }

                const playerPullCurrency = getPlayerItemSync(playerId, pullCurrencyId)
                if (playerPullCurrency === null) throw new BoxGachaExecError("No pull currency.")
                const requestedCost = pullCount * boxGachaData.redeemItemCount
                if (playerPullCurrency < requestedCost) {
                    throw new BoxGachaExecError("Not enough pull currency.")
                }

                const effectiveStop = stopOnFeaturedRewards && settings.resetKind === 0
                const drawResult = drawBoxGachaSync(
                    boxRewards,
                    playerDrawnRewards,
                    pullCount,
                    effectiveStop,
                )
                const drawnRewards = drawResult.rewards
                const actualDrawCount = drawnRewards.reduce((sum, reward) => sum + reward.number, 0)
                if (actualDrawCount <= 0 || actualDrawCount > pullCount) {
                    throw new Error("Box gacha produced an invalid draw count.")
                }
                const newPullCurrency = playerPullCurrency
                    - actualDrawCount * boxGachaData.redeemItemCount
                const rewardResult = rewardPlayerBoxGachaResultSync(playerId, drawResult)

                const playerDrawnRewardMap = new Map(
                    playerDrawnRewards.map(reward => [reward.id, reward.number]),
                )
                const remainingDrawsNumber = remainingBefore - actualDrawCount
                const shouldClose = remainingDrawsNumber === 0
                if (playerBoxData === null) {
                    insertPlayerBoxGachaSync(playerId, boxGachaId, {
                        boxId,
                        isClosed: shouldClose,
                        remainingNumber: remainingDrawsNumber,
                        resetTimes: 0,
                    })
                } else {
                    updatePlayerBoxGachaSync(playerId, boxGachaId, {
                        boxId,
                        isClosed: shouldClose,
                        remainingNumber: remainingDrawsNumber,
                    })
                }

                for (const drawnReward of drawnRewards) {
                    const existing = playerDrawnRewardMap.get(drawnReward.id)
                    if (existing === undefined) {
                        insertPlayerBoxGachaDrawnRewardSync(playerId, boxGachaId, boxId, {
                            id: drawnReward.id,
                            number: drawnReward.number,
                        })
                    } else {
                        updatePlayerBoxGachaDrawnRewardSync(
                            playerId,
                            boxGachaId,
                            boxId,
                            drawnReward.id,
                            existing + drawnReward.number,
                        )
                    }
                }
                updatePlayerItemSync(playerId, pullCurrencyId, newPullCurrency)
                return {
                    player,
                    playerBoxData,
                    drawnRewards,
                    rewardResult,
                    newPullCurrency,
                    remainingDrawsNumber,
                    shouldClose,
                }
            })()
        } catch (error) {
            if (error instanceof BoxGachaExecError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }

        const allBoxInfo: Object[] = getAllBoxList(playerId, boxGachaId, boxGachaData.boxes, boxId)
        const currentDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)
        allBoxInfo.push({
            "box_id": boxId,
            "reset_times": settlement.playerBoxData?.resetTimes ?? 0,
            "all_drawn_reward_list": currentDrawnRewards.map(reward => ({
                "reward_id": reward.id,
                "number": reward.number,
            })),
            "coming_next_reward_list": [],
            "is_closed": settlement.shouldClose,
        })

        const existingCharacterList = (settlement.rewardResult?.character_list ?? []) as Record<string, unknown>[]
        const characterList = publishAwakeCharacterListBestEffort(
            playerId,
            settlement.rewardResult?.joined_character_id_list ?? [],
            [existingCharacterList],
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": settlement.player.freeMana + (settlement.rewardResult?.user_info.free_mana ?? 0),
                    "exp_pool": settlement.player.expPool + (settlement.rewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": expPoolRealDateToClientTimestamp(settlement.player.expPooledTime),
                },
                "drawn_reward_list": settlement.drawnRewards.map(reward => {
                    return {
                        "reward_id": reward.id,
                        "number": reward.number
                    }
                }),
                "all_box_info": allBoxInfo,
                "joined_character_id_list": settlement.rewardResult?.joined_character_id_list ?? [],
                "character_list": characterList,
                "equipment_list": settlement.rewardResult?.equipment_list ?? [],
                "item_list": {
                    [pullCurrencyId]: settlement.newPullCurrency,
                    ...(settlement.rewardResult?.items ?? {})
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

    fastify.post("/get_box_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetBoxListBody

        const viewerId = body.viewer_id
        const boxGachaId = body.box_gacha_id
        console.log(`[BOX] get_box_list: boxGachaId=${boxGachaId}`)
        if (isNaN(viewerId) || isNaN(boxGachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get box gacha data
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes)
            }
        })
    })
}

export default routes;
