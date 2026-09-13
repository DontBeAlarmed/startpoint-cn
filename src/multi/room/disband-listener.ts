import { sessionManager } from "../state/SessionManager"
import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { setRoomDisbandListener } from "./manager"

/**
 * Every disband path funnels through manager.disbandRoom, which invokes the
 * registered room disband listener. Interactive paths (HTTP disband, host
 * disconnect) already broadcast "multibattle_room_dismissed" before deleting
 * the room, but the cleaner paths (idle expiry, abandoned battle recycling)
 * and direct disbandRoom callers reach the choke point without any
 * client-facing teardown — clients only leave the room on the dismissed
 * message (MultiBattleRoomScene), so a silent delete leaves ghost sockets
 * bound to a recyclable room number. The listener therefore owns the
 * broadcast, the socket teardown and the abandoned active-quest release.
 * Duplicate broadcasts from interactive paths are inert: their recipients
 * are already closed or leaving.
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
