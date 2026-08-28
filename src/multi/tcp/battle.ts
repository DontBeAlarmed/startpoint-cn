import * as net from "net"
import { getQuestFromCategorySync } from "../../lib/assets"
import { QuestCategory } from "../../lib/types"
import { getRoom } from "../room/manager"
import { sessionManager, SessionClient } from "../state/SessionManager"
import { relayToBattleRoom } from "./relay"
import { getRealNowMs } from "../../runtime/time/game-time"

const BATTLE_MEASUREMENT_WARNING_THRESHOLD_MS = 2000

function findBattleClientBySocket(socket: net.Socket): SessionClient | undefined {
    return sessionManager.getBattleClientBySocket(socket)
}

function getRoomQuest(client: SessionClient) {
    const room = getRoom(client.roomNumber)
    if (!room) return undefined
    try {
        const quest = getQuestFromCategorySync(room.category, room.quest_id)
        return quest ? { quest, room } : undefined
    } catch {
        return undefined
    }
}

function handleBattleNotify(socket: net.Socket, data: unknown): void {
    if (!Array.isArray(data)) return
    const tag = data[0] as number
    const client = findBattleClientBySocket(socket)

    switch (tag) {
        case 0: { // SceneReady
            if (!client) break
            const allReady = sessionManager.markSceneReady(client.connectionId, client.roomNumber)
            if (allReady) {
                sessionManager.activateBattleScene(client.roomNumber)
            } else {
                if (sessionManager.isBattleSceneBarrierReleased(client.roomNumber)) {
                    sessionManager.replayBattleStartIfNeeded(client.connectionId, client.roomNumber)
                }
            }
            break
        }
        case 1: { // LevelNext
            if (!client) break
            const context = getRoomQuest(client)
            if (context?.room.category === QuestCategory.BOSS_BATTLE
                && context.quest.isBothBoss === true) {
                sessionManager.beginNextBattleScene(client.connectionId, client.roomNumber)
            }
            break
        }
        case 2: { // Finalize
            if (!client) break
            const context = getRoomQuest(client)
            if (context && sessionManager.canFinalizeBattle(
                client.roomNumber,
                context.room.category === QuestCategory.BOSS_BATTLE
                    && context.quest.isBothBoss === true,
            ) && sessionManager.markBattleFinalized(client.connectionId, client.roomNumber)) {
                sessionManager.sendJson(client.socket, [1, [2]])
            }
            break
        }
        case 3: { // Measurement
            if (client) {
                const frame = data[1] ?? 0
                const clientTime = data[2] ?? 0
                sessionManager.sendJson(client.socket, [1, [3, frame, clientTime, BATTLE_MEASUREMENT_WARNING_THRESHOLD_MS]])
            }
            break
        }
        case 4: { // LineSpeedWarning
            if (client) {
                sessionManager.broadcastToBattleRoom(client.roomNumber, [1, [4, client.connectionId, data[1] ?? 0]])
            }
            break
        }
        case 5: // Heartbeat is a keepalive notification and has no response frame.
            break
        default:
            break
    }
}

export function handleBattleMessage(socket: net.Socket, data: unknown): void {
    if (!Array.isArray(data)) return
    const tag = data[0] as number
    const activityClient = findBattleClientBySocket(socket)
    if (activityClient) sessionManager.noteBattleActivity(activityClient.connectionId)

    switch (tag) {
        case 0: // Notify
            handleBattleNotify(socket, data[1])
            break
        case 1: { // Broadcast → relay as BattleServer2Client.Messages(2, senderId, array)
            const client = findBattleClientBySocket(socket)
            if (client) {
                const bcData = data[1]
                relayToBattleRoom(client, [2, client.connectionId, bcData])
                sessionManager.sendJson(socket, [1, [3, 0, 0, getRealNowMs()]])
            }
            break
        }
        case 2: { // Send → relay as BattleServer2Client.Send(3, senderId, message)
            const client = findBattleClientBySocket(socket)
            if (client) {
                const sendMsg = data[2]
                if (sendMsg) {
                    relayToBattleRoom(client, [3, client.connectionId, sendMsg])
                }
                sessionManager.sendJson(socket, [1, [3, 0, 0, getRealNowMs()]])
            }
            break
        }
        default:
            break
    }
}
