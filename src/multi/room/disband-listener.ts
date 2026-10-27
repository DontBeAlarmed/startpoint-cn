import { sessionManager } from "../state/SessionManager"
import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { closeRecruitmentForRoom } from "../../data/domains/attention"
import { describeError } from "../describe-error"
import { setRoomDisbandListener, setRoomReleaseListener } from "./manager"

/**
 * Every disband path funnels through manager.disbandRoom, which invokes the
 * registered room disband listener. The listener owns client dismissal,
 * socket teardown and abandoned active-quest release so callers do not emit
 * a second dismissal before deleting the room.
 */
export function installDisbandLifecycleListener(): void {
    // OV-2：战斗释放（4→1）即 host 回房宽限起点；host 重进 Enter 取消
    // （tcp/lobby handleEnter 既有 cancel 点），宽限到期仍未重进 → 解散。
    setRoomReleaseListener((roomNumber, hostNodeSessionId, hostViewerId) => {
        try {
            const { scheduleHostReturnLease } = require("../tcp/lobby") as typeof import("../tcp/lobby")
            // NodeSessionId 是 room 层 plain string 的 brand 视图；此处一次性还原
            scheduleHostReturnLease(roomNumber, {
                nodeSessionId: hostNodeSessionId as Parameters<typeof scheduleHostReturnLease>[1]["nodeSessionId"],
                viewerId: hostViewerId,
            })
        } catch (error) {
            console.warn(`[MULTI] host return lease failed: room=${roomNumber}: ${describeError(error)}`)
        }
    })
    setRoomDisbandListener((roomNumber, hostPlayerId, hostViewerId) => {
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
        try {
            // 铃铛招募行同样覆盖全部解散路径：此前只有 HTTP disband/开战/NPC
            // 补位会关行，计时器解散留下 open 行 → 死房铃铛（bell-gate 对
            // 本节点缺房放行）最长存活到 45s TTL。
            closeRecruitmentForRoom(hostViewerId, roomNumber)
        } catch (error) {
            console.error(`[MULTI] recruitment disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        }
    })
}
