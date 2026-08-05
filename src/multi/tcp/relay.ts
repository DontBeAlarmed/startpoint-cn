import { sessionManager } from "../state/SessionManager"

export function relayToBattleRoom(roomNumber: string, sourceCid: string, data: unknown): void {
    for (const client of sessionManager.getBattleClientsInRoom(roomNumber)) {
        if (client.connectionId !== sourceCid) {
            sessionManager.sendJson(client.socket, data)
        }
    }
}
