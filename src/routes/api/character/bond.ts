// Character bond token and mana board opening endpoints

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharacterManaNodesSync, getPlayerCharacterSync, insertPlayerCharacterBondTokenSync, updatePlayerCharacterBondTokenSync, updatePlayerCharacterSync } from "../../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { getSession } from "../../../data/domains/session"
import { getServerDate } from "../../../utils";
import { getCharacterDataSync, getCharacterManaBoardCountSync, getCharacterManaNodesSync } from "../../../lib/assets";
import { resolvePlayerIdSync } from "../../../data/activeAccount";
import { validateSessionAndPlayer, validateCharacterOwnership, buildCharacterListEntry, sendCharacterResponse } from "../../../lib/character-helpers";
import { characterExpCaps } from "../../../lib/character";
import {
    mergeMissionSettlementResponse,
    reconcileAwakeUnlockCharacterListBestEffort,
    settleMissionCategories,
} from "../../../lib/mission";
import { getMailArrivedSync } from "../../../lib/mail-notification";
import { isCharacterSecondManaBoardAvailable } from "../../../lib/mana-board-availability";
import { getDb } from "../../../data/db";
import { createAwakeRequestContextBestEffort } from "../../../lib/mission/awake-best-effort-context";

interface ReceiveBondTokenBody {
    character_id: number,
    mana_board_index: number,
    api_count: number,
    viewer_id: number
}

const openManaBoardRequiredUncaps: Record<number, number> = {
    [1]: 10, [2]: 8, [3]: 6, [4]: 4, [5]: 2
}

const openManaBoardRequiredExp: Record<number, number> = {
    [3]: characterExpCaps[3][0],
    [4]: characterExpCaps[4][0],
    [5]: characterExpCaps[5][0]
}

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/receive_bond_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBondTokenBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const manaBoardIndex = body.mana_board_index
        console.log(`[MANA] receive_bond_token: viewer=${viewerId} char=${characterId} boardIdx=${manaBoardIndex}`)
        if (isNaN(viewerId) || isNaN(characterId) || isNaN(manaBoardIndex)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sess = await validateSessionAndPlayer(viewerId, reply)
        if (!sess) return
        const { playerId, player } = sess

        const characterData = validateCharacterOwnership(playerId, characterId, reply)
        if (!characterData) return

        if (manaBoardIndex === 2 && !isCharacterSecondManaBoardAvailable(characterId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Second mana board is not available."
            })
        }

        const bondToken = characterData.bondTokenList[manaBoardIndex - 1]
        if (!bondToken || bondToken.status === 0) return reply.status(400).send({
            "error": "Bad Request", "message": "Cannot receive bond token."
        })

        // Already claimed — return current state
        if (bondToken.status === 2) {
            return sendCharacterResponse(reply, viewerId, {
                user_info: { bond_token: player.bondToken },
                character_list: [buildCharacterListEntry(characterId, characterData, {
                    bond_token_list: characterData.bondTokenList.map(e => ({ mana_board_index: e.manaBoardIndex, status: e.status })),
                })],
                user_character_mana_node_list: {},
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(playerId),
            })
        }

        const newBondTokens = player.bondToken + 1
        const bondTokenList: Object[] = []
        for (const entry of characterData.bondTokenList) {
            bondTokenList.push({ "mana_board_index": entry.manaBoardIndex, "status": entry.manaBoardIndex === manaBoardIndex ? 2 : entry.status })
        }
        const characterList = getDb().transaction(() => {
            updatePlayerSync({ id: playerId, bondToken: newBondTokens })
            updatePlayerCharacterBondTokenSync(playerId, characterId, { manaBoardIndex, status: 2 })
            const candidateCharacterIds = [characterId]
            const awakeContext = createAwakeRequestContextBestEffort(playerId, candidateCharacterIds)
            const existingCharacterList = [
                buildCharacterListEntry(characterId, characterData, { bond_token_list: bondTokenList }),
            ]
            return awakeContext === null
                ? existingCharacterList
                : reconcileAwakeUnlockCharacterListBestEffort(
                    playerId,
                    existingCharacterList,
                    { context: awakeContext, candidateCharacterIds },
                )
        })()

        return sendCharacterResponse(reply, viewerId, {
            user_info: { bond_token: newBondTokens },
            character_list: characterList,
            user_character_mana_node_list: {},
            item_list: {},
            evolution: [],
            mail_arrived: getMailArrivedSync(playerId),
        })
    })

    fastify.post("/open_mana_board", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBondTokenBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const manaBoardIndex = body.mana_board_index
        console.log(`[MANA] open_mana_board: viewer=${viewerId} char=${characterId} boardIdx=${manaBoardIndex}`)
        if (isNaN(viewerId) || isNaN(characterId) || isNaN(manaBoardIndex)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No players bound to account."
        })

        // get character data
        const characterData = getPlayerCharacterSync(playerId, characterId)
        if (characterData === null) return reply.status(400).send({
            "error": "Bad Request", "message": "Character not owned."
        })

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No character asset data found."
        })

        const boardCount = getCharacterManaBoardCountSync(characterId)
        if (!Number.isInteger(manaBoardIndex) || manaBoardIndex < 2 || manaBoardIndex > boardCount) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Mana board index is not openable."
            })
        }
        if (manaBoardIndex === 2 && !isCharacterSecondManaBoardAvailable(characterId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Second mana board is not available."
            })
        }

        // ensure that the mana board can be opened
        const requiredLevelExp = openManaBoardRequiredExp[characterAssetData.rarity]
        if (requiredLevelExp !== undefined && requiredLevelExp > characterData.exp) {
            console.log(`[MANA] open_mana_board FAIL: exp too low, need=${requiredLevelExp} have=${characterData.exp}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": `Character level is too low to unlock mana board.`
            })
        }
        if (openManaBoardRequiredUncaps[characterAssetData.rarity] > characterData.overLimitStep) {
            console.log(`[MANA] open_mana_board FAIL: uncap too low, need=${openManaBoardRequiredUncaps[characterAssetData.rarity]} have=${characterData.overLimitStep}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": `Character is not uncapped enough to unlock mana board.`
            })
        }
        if (manaBoardIndex === 2) {
            const firstBoardNodes = getCharacterManaNodesSync(characterId, 1)
            const learnedNodeIds = new Set(getPlayerCharacterManaNodesSync(playerId, characterId))
            const firstBoardComplete = firstBoardNodes !== null
                && Object.keys(firstBoardNodes).every(nodeId => learnedNodeIds.has(Number(nodeId)))
            if (!firstBoardComplete) {
                console.log(`[MANA] open_mana_board FAIL: first board is incomplete, char=${characterId}`)
                return reply.status(400).send({
                    "error": "Bad Request", "message": `Must unlock all previous mana board nodes.`
                })
            }
        } else if (1 > characterData.bondTokenList[manaBoardIndex - 2]?.status) {
            console.log(`[MANA] open_mana_board FAIL: prev board bond not claimed, prevIdx=${manaBoardIndex - 2} prevStatus=${characterData.bondTokenList[manaBoardIndex - 2]?.status}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": `Must unlock all previous mana board nodes.`
            })
        }

        const existingBondTokenIndices = new Set(
            characterData.bondTokenList.map(entry => entry.manaBoardIndex)
        )
        const missingBondTokenIndices: number[] = []
        for (let index = 1; index <= boardCount; index++) {
            if (!existingBondTokenIndices.has(index)) missingBondTokenIndices.push(index)
        }
        if (missingBondTokenIndices.length > 0) {
            console.log(`[MANA] open_mana_board: auto-creating bond tokens, missing=${missingBondTokenIndices.join(",")} boardCount=${boardCount}`)
        }

        const characterUpdate = { manaBoardIndex, updateTime: new Date() }
        getDb().transaction(() => {
            for (const index of missingBondTokenIndices) {
                insertPlayerCharacterBondTokenSync(playerId, characterId, {
                    manaBoardIndex: index,
                    status: 0,
                })
            }
            updatePlayerCharacterSync(playerId, characterId, characterUpdate)
        })()

        const finalCharacterData = {
            ...characterData,
            ...characterUpdate,
            bondTokenList: [
                ...characterData.bondTokenList,
                ...missingBondTokenIndices.map(index => ({
                    manaBoardIndex: index,
                    status: 0,
                })),
            ],
        }

        const missionSettlement = settleMissionCategories(playerId, [1], getServerDate())
        const responseData = {
            "user_info": {},
            "character_list": [buildCharacterListEntry(characterId, finalCharacterData, {
                "viewer_id": viewerId,
                "mana_board_index": finalCharacterData.manaBoardIndex,
            })],
            "user_character_mana_node_list": {},
            "item_list": {},
            "evolution": [],
            "mail_arrived": getMailArrivedSync(playerId),
            "mission_info": [],
            "equipment_list": [],
            "degree_list": [],
        }
        mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)
        responseData.mail_arrived = getMailArrivedSync(playerId)
        return sendCharacterResponse(reply, viewerId, responseData)
    })
}

export default routes;
