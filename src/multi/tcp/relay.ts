import { sessionManager } from "../state/SessionManager"
import type { SessionClient } from "../state/SessionManager"

export function relayToBattleRoom(source: SessionClient, data: unknown): void {
    const recipients = sessionManager.snapshotBattleRelayRecipients(source)
    if (recipients.length === 0) return
    const frame = JSON.stringify(data) + "\0"
    for (const client of recipients) sessionManager.sendFrame(client.socket, frame)
}
