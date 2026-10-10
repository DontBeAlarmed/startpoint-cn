import { sessionManager } from "../state/SessionManager"
import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { describeError } from "../describe-error"
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
            console.error(`[MULTI] disband broadcast failed: room=${roomNumber}: ${describeError(error)}`)
        }
        try {
            sessionManager.closeRoomClients(roomNumber)
        } catch (error) {
            console.error(`[MULTI] disband client cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        }
        try {
            releaseAbandonedMultiActiveQuest(hostPlayerId, roomNumber)
        } catch (error) {
            console.error(`[MULTI] abandoned host release failed: room=${roomNumber}: ${describeError(error)}`)
        }
        try {
            // 好友房间大厅注册行清理（覆盖 timer/lease 等全部解散路径）
            const { deleteRoomShareRowForDisband } = require("./share-sync") as typeof import("./share-sync")
            deleteRoomShareRowForDisband(roomNumber)
        } catch (error) {
            console.error(`[MULTI] room share disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        }
    })
}
