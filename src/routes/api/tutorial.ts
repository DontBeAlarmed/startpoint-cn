import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, insertMailSync, insertReceiveHistorySync } from "../../data/domains/mail"
import { getMailArrivedSync } from "../../lib/mail-notification"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    getPlayerTriggeredTutorialsSync,
    getTutorialStepReceiptSync,
    insertPlayerTriggeredTutorialSync,
    upsertTutorialStepReceiptSync,
} from "../../data/domains/tutorial"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { clientSerializeDate, serializeBondTokenStatuses } from "../../data/utils"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getGachaSync } from "../../lib/assets";
import { rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { givePlayerCharacterSync } from "../../lib/character";
import { randomInt } from "crypto";
import { GachaCharacterDraw } from "../../lib/types";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import {
    getTutorialEffectiveNextStep,
    TUTORIAL_END_EFFECTIVE_STEP,
    TUTORIAL_GACHA_CHARACTER_IDS,
    TUTORIAL_GACHA_EFFECTIVE_STEP,
    TUTORIAL_PRESENT_EFFECTIVE_STEP,
} from "../../lib/start-tutorial-state";

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

function serializeTutorialReplayCharacter(
    viewerId: number,
    characterId: number,
    character: NonNullable<ReturnType<typeof getPlayerCharacterSync>>,
) {
    return {
        "viewer_id": viewerId,
        "character_id": characterId,
        "entry_count": character.entryCount,
        "evolution_level": character.evolutionLevel,
        "over_limit_step": character.overLimitStep,
        "protection": character.protection,
        "join_time": clientSerializeDate(character.joinTime),
        "update_time": clientSerializeDate(character.updateTime),
        "exp": character.exp,
        "stack": character.stack,
        "mana_board_index": character.manaBoardIndex,
        "bond_token_list": serializeBondTokenStatuses(character.bondTokenList),
        ...(character.exBoost === undefined ? {} : {
            "ex_boost": {
                "status_id": character.exBoost.statusId,
                "ability_id_list": character.exBoost.abilityIdList,
            },
        }),
    }
}

function buildTutorialGachaReplayData(
    playerId: number,
    viewerId: number,
    gachaId: number,
    effectiveNextStep: number,
) {
    const player = getPlayerSync(playerId)
    const characterId = player?.tutorialGachaCharacterId
    if (player === null || characterId === null || characterId === undefined) {
        throw new Error("Tutorial gacha step is missing its persisted draw result")
    }

    const character = getPlayerCharacterSync(playerId, characterId)
    return {
        "step": effectiveNextStep,
        "user_info": {
            "free_vmoney": player.freeVmoney,
        },
        "gacha": {
            "draw": [{
                "character_id": characterId,
                "entry_count": character?.entryCount ?? 1,
                "movie_id": "normal_guarantee",
                "seed": 10007656,
            }],
            "gacha_info_list": [{
                "gacha_id": gachaId,
                "is_account_first": false,
                "is_daily_first": false,
            }],
        },
        "character_list": character === null
            ? []
            : [serializeTutorialReplayCharacter(viewerId, characterId, character)],
        "item_list": {},
        "encyclopedia_info": [],
        "mail_arrived": getMailArrivedSync(playerId),
        "start_time": getServerTime(),
    }
}

function buildTutorialPresentReplayData(
    playerId: number,
    effectiveNextStep: number,
) {
    const player = getPlayerSync(playerId)
    if (player === null) throw new Error("Tutorial player disappeared during replay")
    const character = getPlayerCharacterSync(playerId, freeTutorialCharacterId)

    return {
        "step": effectiveNextStep,
        "user_info": {
            "free_vmoney": player.freeVmoney,
        },
        "character_list": character === null
            ? []
            : [serializeTutorialReplayCharacter(0, freeTutorialCharacterId, character)],
        "item_list": {},
        "encyclopedia_info": {
            [`1${freeTutorialCharacterId}01`]: {
                "read": false,
            },
        },
        "mail_arrived": getMailArrivedSync(playerId),
        "start_time": getServerTime(),
    }
}

function buildTutorialEndData() {
    return {
        "bonus_index_list": null,
        "premium_bonus_index_list": null,
        "premium_bonus_mailed_item_list": null,
        "login_bonus_received_at": null,
        "start_dash_exchange_campaign_list": null,
        "start_time": getServerTime(),
    }
}

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

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const storedNextStep = completedStep + 1
        const effectiveNextStep = getTutorialEffectiveNextStep(completedStep, skip)
        const gachaId = effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP
            && body.gacha_id !== undefined
            && !isNaN(body.gacha_id)
            ? body.gacha_id
            : null
        const gachaData = gachaId === null ? null : getGachaSync(gachaId)

        const result = getDb().transaction(() => {
            const currentPlayer = getPlayerSync(playerId)
            if (currentPlayer === null) throw new Error("Tutorial player disappeared during update")

            const tutorialBranchAlreadyChosen = currentPlayer.tutorialStep !== 0
                || currentPlayer.tutorialSkipFlag !== null
            if (
                tutorialBranchAlreadyChosen
                && Boolean(currentPlayer.tutorialSkipFlag) !== skip
            ) {
                return {
                    ok: false,
                    message: "Tutorial branch does not match the persisted progress.",
                } as const
            }

            const receipt = getTutorialStepReceiptSync(playerId)
            if (
                receipt !== null
                && receipt.completedStep === completedStep
                && receipt.skip === skip
                && (
                    currentPlayer.tutorialStep === storedNextStep
                    || (
                        currentPlayer.tutorialStep === null
                        && effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP
                    )
                )
            ) {
                return { ok: true, data: receipt.responseData } as const
            }

            if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP && gachaData === null) {
                return {
                    ok: false,
                    message: gachaId === null
                        ? "Tutorial gacha step requires a valid gacha id."
                        : `Gacha with id '${body.gacha_id}' does not exist.`,
                } as const
            }

            if (currentPlayer.tutorialStep === null) {
                if (effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP) {
                    return { ok: true, data: buildTutorialEndData() } as const
                }
                return { ok: false, message: "Tutorial already completed." } as const
            }

            const isReplay = currentPlayer.tutorialStep === storedNextStep
            if (!isReplay && currentPlayer.tutorialStep !== completedStep) {
                return {
                    ok: false,
                    message: "Tutorial step does not match the persisted progress.",
                } as const
            }

            if (isReplay) {
                if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                    return {
                        ok: true,
                        data: buildTutorialGachaReplayData(
                            playerId,
                            viewerId,
                            gachaId!,
                            effectiveNextStep,
                        ),
                    } as const
                }
                if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                    return {
                        ok: true,
                        data: buildTutorialPresentReplayData(playerId, effectiveNextStep),
                    } as const
                }
                return {
                    ok: true,
                    data: {
                        "step": effectiveNextStep,
                        ...(body.name === undefined ? {} : { "name": currentPlayer.name }),
                        "mail_arrived": getMailArrivedSync(playerId),
                        "start_time": getServerTime(),
                    },
                } as const
            }

            if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                const randomCharacterIndex = randomInt(0, TUTORIAL_GACHA_CHARACTER_IDS.length)
                const randomCharacterId = TUTORIAL_GACHA_CHARACTER_IDS[randomCharacterIndex]
                const rewardResult = rewardPlayerGachaDrawResultSync(
                    playerId,
                    gachaData!,
                    [randomCharacterId],
                )
                insertReceiveHistorySync(playerId, {
                    type: MailType.CHARACTER,
                    type_id: randomCharacterId,
                    number: 1,
                })

                const newFreeVmoney = currentPlayer.freeVmoney - gachaData!.singleCost
                updatePlayerSync({
                    id: playerId,
                    tutorialStep: storedNextStep,
                    tutorialSkipFlag: skip,
                    tutorialGachaCharacterId: randomCharacterId,
                    freeVmoney: newFreeVmoney,
                    name: body.name,
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

                const data = {
                    "step": effectiveNextStep,
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
                    "mail_arrived": getMailArrivedSync(playerId),
                    "start_time": getServerTime()
                }
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }

            if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                const newVMoney = currentPlayer.freeVmoney + 1500
                insertReceiveHistorySync(playerId, {
                    type: MailType.FREE_VMONEY,
                    type_id: null,
                    number: 1500,
                })

                const giveResult = givePlayerCharacterSync(playerId, freeTutorialCharacterId)
                const existingCharacterList: Record<string, unknown>[] = giveResult?.character
                    ? [giveResult.character as Record<string, unknown>]
                    : []
                const itemList = giveResult?.item
                    ? { [giveResult.item.id]: giveResult.item.count }
                    : {}
                insertReceiveHistorySync(playerId, {
                    type: MailType.CHARACTER,
                    type_id: freeTutorialCharacterId,
                    number: 1,
                })

                insertMailSync(playerId, {
                    reason_id: 0,
                    subject: null,
                    description: null,
                    type: MailType.FREE_VMONEY,
                    type_id: null,
                    number: 500,
                    receive_time: "0000-00-00 00:00:00",
                    create_time: new Date().toISOString().replace("T", " ").substring(0, 19),
                    reward_period_limited: 0,
                    reward_limit_time: null,
                })
                updatePlayerSync({
                    id: playerId,
                    tutorialStep: storedNextStep,
                    tutorialSkipFlag: skip,
                    freeVmoney: newVMoney,
                    name: body.name,
                })

                const characterList = existingCharacterList.length > 0
                    ? reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
                    : existingCharacterList

                const data = {
                    "step": effectiveNextStep,
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
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }

            const isTutorialEnd = effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP
            updatePlayerSync({
                id: playerId,
                tutorialStep: isTutorialEnd ? null : storedNextStep,
                tutorialSkipFlag: skip,
                name: body.name,
            })
            if (isTutorialEnd) {
                const data = buildTutorialEndData()
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }
            const data = {
                "step": effectiveNextStep,
                ...(body.name === undefined ? {} : { "name": body.name }),
                "mail_arrived": getMailArrivedSync(playerId),
                "start_time": getServerTime(),
            }
            upsertTutorialStepReceiptSync(playerId, {
                completedStep,
                skip,
                responseData: data,
            })
            return { ok: true, data } as const
        })()

        if (!result.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result.data,
        })
    })
}

export default routes;
