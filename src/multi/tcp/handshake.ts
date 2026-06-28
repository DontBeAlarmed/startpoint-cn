// Multi battle TCP session handshake
// Protocol: JSON messages delimited by null byte (\0)
// Post-handshake messages use typepacker format with useEnumIndex=true:
//   [index, param1, param2, ...]
//
// HandshakeResult: Accept=0, Denied=1, Reconnect=2, Exception=3, Complete=4

import * as net from "net"
import {
    getSession,
    getAccountPlayers,
    getPlayerSync,
    getPlayerPartyGroupListSync,
    getPlayerCharacterSync,
    getPlayerCharacterManaNodesSync,
    getPlayerEquipmentSync,
} from "../../data/wdfpData"
import { PartyCategory, PlayerParty } from "../../data/types"
import { sessionManager } from "../state/SessionManager"
import type { SessionClient } from "../state/SessionManager"
import { ClientState } from "../types"

const playerRankTable = require("../../../assets/cdndata/player_rank.json")

function getRankLevel(rankPoint: number): number {
    let level = 1
    for (const [lvl, data] of Object.entries(playerRankTable as Record<string, any>)) {
        const threshold = parseInt(data[0][1])
        if (rankPoint >= threshold) level = parseInt(lvl)
    }
    return level
}

export function buildRealParty(playerId: number, targetParty?: PlayerParty): any {
    const emptyChar = [1]
    const filledChars: any[] = []
    const filledUnison: any[] = []
    const filledEquips: any[] = []
    const filledSouls: any[] = []

    // Search for an NPC-named party across NORMAL and EVENT categories
    let selectedParty: PlayerParty | null = targetParty ?? null
    if (!selectedParty) {
        for (const category of [PartyCategory.NORMAL, PartyCategory.EVENT]) {
        const groups = getPlayerPartyGroupListSync(playerId, category)
        for (const g of Object.values(groups)) {
            for (const party of Object.values(g.list)) {
                if (party.name && party.name.includes("NPC")) {
                    selectedParty = party
                    break
                }
            }
            if (selectedParty) break
        }
        if (selectedParty) break
    }
    }

    for (let i = 0; i < 3; i++) {
        const charId = selectedParty?.characterIds[i] ?? null
        if (!charId) {
            filledChars.push([1])
            filledUnison.push([1])
        } else {
            const dbChar = getPlayerCharacterSync(playerId, charId)
            if (!dbChar) {
                filledChars.push([1])
                filledUnison.push([1])
            } else {
                const rawManaNodes = getPlayerCharacterManaNodesSync(playerId, charId)
                const manaNodeMap: Record<string, number> = {}
                for (const id of rawManaNodes) manaNodeMap[String(id)] = 0

                let exBoost: any = [1]
                if (dbChar.exBoost && dbChar.exBoost.abilityIdList && dbChar.exBoost.abilityIdList.length > 0) {
                    exBoost = [0, { ability_id_list: dbChar.exBoost.abilityIdList, status_id: dbChar.exBoost.statusId }]
                }

                const charObj = {
                    id: charId,
                    evolution_level: dbChar.evolutionLevel,
                    exp: dbChar.exp,
                    over_limit_step: dbChar.overLimitStep,
                    mana_node_ids: manaNodeMap,
                    ex_boost: exBoost,
                    illustration_settings: [1],
                }
                filledChars.push([0, charObj])
            }

            const unisonId = selectedParty?.unisonCharacterIds[i] ?? null
            if (!unisonId) {
                filledUnison.push([1])
            } else {
                const dbUnison = getPlayerCharacterSync(playerId, unisonId)
                if (!dbUnison) {
                    filledUnison.push([1])
                } else {
                    const rawNodes = getPlayerCharacterManaNodesSync(playerId, unisonId)
                    const nodeMap: Record<string, number> = {}
                    for (const id of rawNodes) nodeMap[String(id)] = 0

                    let ubEx: any = [1]
                    if (dbUnison.exBoost && dbUnison.exBoost.abilityIdList && dbUnison.exBoost.abilityIdList.length > 0) {
                        ubEx = [0, { ability_id_list: dbUnison.exBoost.abilityIdList, status_id: dbUnison.exBoost.statusId }]
                    }

                    filledUnison.push([0, {
                        id: unisonId,
                        evolution_level: dbUnison.evolutionLevel,
                        exp: dbUnison.exp,
                        over_limit_step: dbUnison.overLimitStep,
                        mana_node_ids: nodeMap,
                        ex_boost: ubEx,
                        illustration_settings: [1],
                    }])
                }
            }
        }

        const equipId = selectedParty?.equipmentIds[i] ?? null
        if (!equipId) {
            filledEquips.push([1])
        } else {
            const dbEquip = getPlayerEquipmentSync(playerId, equipId)
            if (!dbEquip) {
                filledEquips.push([1])
            } else {
                filledEquips.push([0, { equipmentId: equipId, level: dbEquip.level, enhancementLevel: dbEquip.enhancementLevel }])
            }
        }

        const soulId = selectedParty?.abilitySoulIds[i] ?? null
        filledSouls.push(soulId ? [0, soulId] : [1])
    }

    return {
        characters: filledChars,
        unison_characters: filledUnison,
        equipments: filledEquips,
        abilitySoulIds: filledSouls,
    }
}

export async function handleHandshake(socket: net.Socket, data: any): Promise<void> {
    console.log(`[TCP] handshake:`, JSON.stringify(data).substring(0, 200))

    const socklet = data.socklet
    const roomNumber = data.room_number || data.roomNumber

    if (socklet === "cooperation_battle") {
        const connectionId = data.connection_id || data.connectionId || `${socket.remoteAddress}:${socket.remotePort}`
        if (!roomNumber) {
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        const battleClient = sessionManager.createClient(socket, 0, String(roomNumber), String(connectionId), null)
        battleClient.isBattle = true
        sessionManager.addBattleClient(String(connectionId), battleClient)
        sessionManager.sendJson(socket, [0, roomNumber, ""])
        return
    }

    if (socklet === "cooperation_room") {
        const viewerId = data.viewerId
        if (!viewerId || !roomNumber) {
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        const session = await getSession(String(viewerId))
        if (!session) {
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        const playerIds = await getAccountPlayers(session.accountId)
        if (!playerIds || playerIds.length === 0 || isNaN(playerIds[0])) {
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        const player = getPlayerSync(playerIds[0])
        if (!player) {
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        const playerId = playerIds[0]
        const connectionId = data.connection_id || data.connectionId || `${socket.remoteAddress}:${socket.remotePort}`
        const client = sessionManager.createClient(socket, Number(viewerId), String(roomNumber), String(connectionId), playerId)
        client.clientState.tryTransition(ClientState.Handshaking)

        const party = buildRealParty(playerId)
        const yourSelf = {
            viewerId: Number(viewerId),
            playerId: playerId,
            name: player.name,
            rank: getRankLevel(player.rankPoint || 0),
            degreeId: player.degreeId || 1,
            mainCharacterId: player.leaderCharacterId,
            party,
            connectionId,
            playerRoleKind: player.role || 1,
            isNewbie: !!player.tutorialStep,
            isHost: true,
            entryTime: Date.now(),
            currentPartyId: player.partySlot || 1,
            autoplayMode: false,
            autoskillMode: 1,
            autoSpeedLevel: 1,
            autoStart: false,
            skillAbilityBehaviorMode: 1,
            dashBehaviorMode: 1,
            allowHealFromOtherPlayers: true,
            state: [0],
        }
        client.yourself = yourSelf

        sessionManager.addClientToRoom(client)
        sessionManager.sendJson(socket, [0, connectionId, roomNumber])
        return
    }

    // Unknown socklet
    sessionManager.sendJson(socket, [1, "DENIED"])
    socket.end()
}
