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
        // 静默拆除（5805 竞态消除，2026-10-30 用户稳定复现定案）：先从广播
        // 名册摘除全部房间 client，再对每个 socket 恰好发送一次 dismiss 并
        // 关闭——dismiss 之后该 socket 不会再收到任何房间命令，客户端拆除
        // 期间（cooperationRoomStatus 已置 None）无消息可命中 5805 的抛点。
        // 旧序（先广播后关闭）在广播与关闭之间仍会投递 mate/ready 等在途
        // 房间命令，命中拆除中的客户端。
        try {
            sessionManager.dismissAndDetachRoomClients(roomNumber)
        } catch (error) {
            console.error(`[MULTI] disband dismiss failed: room=${roomNumber}: ${describeError(error)}`)
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
        // W1a：closeRecruitmentForRoom 为异步形状——同步 listener 内
        // fire-and-forget（拒绝就地捕获，不得成为 unhandled rejection）
        void closeRecruitmentForRoom(hostViewerId, roomNumber).catch(error => {
            console.error(`[MULTI] recruitment disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        })
    })
}
