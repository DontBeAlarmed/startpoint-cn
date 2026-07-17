import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, insertMailSync, insertReceiveHistorySync } from "../../data/domains/mail"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getPlayerTriggeredTutorialsSync, insertPlayerTriggeredTutorialSync } from "../../data/domains/tutorial"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getGachaSync } from "../../lib/assets";
import { randomPoolItem, rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { givePlayerCharacterSync } from "../../lib/character";
import { randomInt } from "crypto";
import { GachaCharacterDraw } from "../../lib/types";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";

interface UpdateStepBody {
    viewer_id: number
    step: number
    api_count: number
    skip: boolean
    statistics: Object
    name?: string
    gacha_id?: number
}

interface FinishTriggerBody {
    api_count: number,
    tutorial_ids: number[],
    viewer_id: number
}

const freeTutorialCharacterId = 243001

const tutorialGachaCharacterIds = [251001, 251002, 251003, 251004, 251005, 251006, 251007, 251008]

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/finish_trigger", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishTriggerBody

        const viewerId = body.viewer_id
        const tutorialIds = body.tutorial_ids
        if (!viewerId || isNaN(viewerId) || !tutorialIds || !(tutorialIds instanceof Array)) return reply.status(400).send({
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

        // Mark tutorial as having been completed (skip already triggered)
        const existing = getPlayerTriggeredTutorialsSync(playerId)
        for (const tutorialId of tutorialIds) {
            if (!existing.find((v: number) => v === tutorialId)) {
                insertPlayerTriggeredTutorialSync(playerId, tutorialId)
            }
        }

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    })

    fastify.post("/update_step", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateStepBody

        const viewerId = body.viewer_id
        const completedStep = body.step
        const skip = body.skip || false
        if (!viewerId || isNaN(completedStep) || isNaN(viewerId)) return reply.status(400).send({
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
            "message": "No player bound to account."
        })

        // check if tutorial is already completed
        const completedTutorial = getPlayerTriggeredTutorialsSync(playerId)
        if (completedTutorial.find((value: number) => value === 12)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Tutorial already completed"
        })

        // update player
        const currentStep = player.tutorialStep
        let nextStep = completedStep + 1

        if ((currentStep || 0) > nextStep) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Attempt to redo previous tutorial step."
        })

        updatePlayerSync({
            id: playerId,
            tutorialStep: nextStep,
            tutorialSkipFlag: skip,
            name: body.name
        })
        
        // offset nextStep by 11 if skipped, to keep steps the same.
        nextStep += (body.skip ? 11 : 0)
        
        reply.header("content-type", "application/x-msgpack")
        const headers = generateDataHeaders({
            viewer_id: viewerId
        })
        if (nextStep === 15 && body.gacha_id !== undefined && !isNaN(body.gacha_id)) {
            
            const gachaId = body.gacha_id
            const gachaData = getGachaSync(gachaId)
            if (gachaData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Gacha with id '${body.gacha_id}' does not exist.`
            })

            // perform pull
            const randomCharacterIndex = randomInt(0, tutorialGachaCharacterIds.length)
            const randomCharacterId = tutorialGachaCharacterIds[randomCharacterIndex]
            const drawResult = [randomCharacterId]

            // reward pull
            const rewardResult = rewardPlayerGachaDrawResultSync(playerId, gachaData, drawResult)
            insertReceiveHistorySync(playerId, { type: MailType.CHARACTER, type_id: randomCharacterId, number: 1 })

            const newFreeVmoney = player.freeVmoney - gachaData.singleCost
            updatePlayerSync({
                id: playerId,
                freeVmoney: newFreeVmoney,
                tutorialGachaCharacterId: randomCharacterId
            })

            const draw = rewardResult.draw[0] as GachaCharacterDraw
            draw.movie_id = "normal_guarantee"
            draw.seed = 10007656

            const existingCharacterList = rewardResult.characters.filter(
                (character): character is Record<string, unknown> =>
                    character !== undefined
                    && character !== null
                    && typeof character === "object"
                    && !Array.isArray(character)
            )
            const characterList = existingCharacterList.length > 0
                ? reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
                : existingCharacterList

            return reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "user_info": {
                        "free_vmoney": newFreeVmoney,
                    },
                    "gacha": {
                        "draw": rewardResult.draw,
                        "gacha_info_list": [
                            {
                                "gacha_id": gachaId,
                                "is_account_first": false,
                                "is_daily_first": false,
                            }
                        ],
                    },
                    "character_list": characterList,
                    "item_list": rewardResult.items,
                    "encyclopedia_info": [],
                    "mail_arrived": false,
                    "start_time": getServerTime()
                }
            })
        } else if (nextStep === 16) {
            // give 1500 vmoney
            const newVMoney = player.freeVmoney + 1500
            updatePlayerSync({
                id: playerId,
                freeVmoney: newVMoney
            })
            insertReceiveHistorySync(playerId, { type: MailType.FREE_VMONEY, type_id: null, number: 1500 })

            // give free character directly (required for tutorial popup)
            const giveResult = givePlayerCharacterSync(playerId, freeTutorialCharacterId)
            const existingCharacterList: Record<string, unknown>[] = giveResult?.character
                ? [giveResult.character as Record<string, unknown>]
                : []
            const itemList = giveResult?.item
                ? { [giveResult.item.id]: giveResult.item.count }
                : {}
            insertReceiveHistorySync(playerId, { type: MailType.CHARACTER, type_id: freeTutorialCharacterId, number: 1 })

            // also send a mail with tutorial gift (gacha ticket, etc.)
            insertMailSync(playerId, {
                reason_id: 0,
                subject: null,
                description: null,
                type: MailType.FREE_VMONEY,
                type_id: null,
                number: 500,
                receive_time: '0000-00-00 00:00:00',
                create_time: new Date().toISOString().replace('T', ' ').substring(0, 19),
                reward_period_limited: 0,
                reward_limit_time: null,
            })

            const characterList = existingCharacterList.length > 0
                ? reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
                : existingCharacterList

            reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "user_info": {
                        "free_vmoney": newVMoney
                    },
                    "character_list": characterList,
                    "item_list": itemList,
                    "encyclopedia_info": {
                        [`1${freeTutorialCharacterId}01`]: {
                            "read": false
                        }
                    },
                    "mail_arrived": true,
                    "start_time": getServerTime()
                }
            })
        } else {
            
            reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "mail_arrived": true,
                    "start_time": getServerTime()
                }
            })
        }
        
        
    })
}

export default routes;
