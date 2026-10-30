import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { closeRecruitmentForRoom } from "../../data/domains/attention"
import { describeError } from "../describe-error"
import { setRoomDisbandListener, setRoomReleaseListener } from "./manager"

/**
 * Every disband path funnels through manager.disbandRoom, which now owns the
 * client dismissal (dismiss-only) and socket teardown. This listener keeps
 * only persistence cleanup, so there is no second dismissal path.
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
        // 拆除已在 manager.disbandRoom 完成（dismiss-only）；这里只做持久层清理。
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
        // W1a：closeRecruitmentForRoom 为异步形状——同步 listener 内
        // fire-and-forget（拒绝就地捕获，不得成为 unhandled rejection）
        void closeRecruitmentForRoom(hostViewerId, roomNumber).catch(error => {
            console.error(`[MULTI] recruitment disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        })
    })
}
