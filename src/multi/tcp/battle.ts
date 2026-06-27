import * as net from "net"
import { sessionManager, SessionClient } from "../state/SessionManager"
import { relayToBattleRoom } from "./relay"

function findBattleClientBySocket(socket: net.Socket): SessionClient | undefined {
    const map = (sessionManager as any).cidToBattleClient as Map<string, SessionClient> | undefined
    if (!map) return undefined
    for (const client of map.values()) {
        if (client.socket === socket) return client
    }
    return undefined
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
                const bSet = (sessionManager as any).battleClients?.get?.(client.roomNumber) as Set<string> | undefined
                if (bSet) {
                    for (const cid of bSet) {
                        const c = sessionManager.getBattleClient(cid)
                        if (c) sessionManager.sendJson(c.socket, [1, [1]])
                    }
                }
            }
            break
        }
        case 1: { // Finalize
            if (client) sessionManager.sendJson(client.socket, [1, [2]])
            break
        }
        case 2: { // Measurement
            if (client) {
                const params = data[1]
                const frame = params?.[0] ?? 0
                const clientTime = params?.[1] ?? 0
                sessionManager.sendJson(client.socket, [1, [3, frame, clientTime, Date.now()]])
            }
            break
        }
        case 4: // Heartbeat
            if (client) sessionManager.sendJson(client.socket, [1, [3, 0, 0, Date.now()]])
            break
        default:
            break
    }
}

export function handleBattleMessage(socket: net.Socket, data: unknown): void {
    if (!Array.isArray(data)) return
    const tag = data[0] as number

    switch (tag) {
        case 0: // Notify
            handleBattleNotify(socket, data[1])
            break
        case 1: { // Broadcast → relay as BattleServer2Client.Messages(2, senderId, array)
            const client = findBattleClientBySocket(socket)
            if (client) {
                const bcData = data[1]
                relayToBattleRoom(String(client.roomNumber), String(client.connectionId), [2, client.connectionId, bcData])
                sessionManager.sendJson(socket, [1, [3, 0, 0, Date.now()]])
            }
            break
        }
        case 2: { // Send → relay as BattleServer2Client.Send(3, senderId, message)
            const client = findBattleClientBySocket(socket)
            if (client) {
                const sendMsg = data[2]
                if (sendMsg) {
                    relayToBattleRoom(String(client.roomNumber), String(client.connectionId), [3, client.connectionId, sendMsg])
                }
                sessionManager.sendJson(socket, [1, [3, 0, 0, Date.now()]])
            }
            break
        }
        default:
            break
    }
}
