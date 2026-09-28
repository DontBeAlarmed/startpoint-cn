import { sessionManager } from "../state/SessionManager"
import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { setRoomDisbandListener } from "./manager"

/**
 * Every disband path funnels through manager.disbandRoom, which invokes the
 * registered room disband listener. The listener owns client dismissal,
 * socket teardown and abandoned active-quest release so callers do not emit
 * a second dismissal before deleting the room.
 */
export function installDisbandLifecycleListener(): void {
    setRoomDisbandListener((roomNumber, hostPlayerId) => {
        try {
            sessionManager.broadcastToRoom(roomNumber, [1, [6, "multibattle_room_dismissed"]])
        } catch (error) {
            console.error(`[MULTI] disband broadcast failed: room=${roomNumber}: ${describe(error)}`)
        }
        try {
            sessionManager.closeRoomClients(roomNumber)
        } catch (error) {
            console.error(`[MULTI] disband client cleanup failed: room=${roomNumber}: ${describe(error)}`)
        }
        try {
            releaseAbandonedMultiActiveQuest(hostPlayerId, roomNumber)
        } catch (error) {
            console.error(`[MULTI] abandoned host release failed: room=${roomNumber}: ${describe(error)}`)
        }
    })
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
