import {
    refreshRoomShareRowSync,
} from "../../data/domains/social-room-shares"

/**
 * social_room_shares 注册行的生命周期同步（好友房间大厅）。
 *
 * 由房间权威节点的变更点（raising_state/mates/disband）调用；未开放列表
 * 可见性的房没有注册行，refresh 是 no-op，静默跳过。失败只 WARN——注册
 * 表是显示/发现数据，进房的权威校验在 select_room/prepare。
 *
 * 惰性 require room manager：本模块被 manager 的钩子调用，顶层 require
 * 会形成 manager → share-sync → manager 循环。
 */
export function syncRoomShareRow(roomNumber: string): void {
    try {
        const { getRoom } = require("./manager") as typeof import("./manager")
        const room = getRoom(roomNumber)
        if (!room) return
        refreshRoomShareRowSync(
            roomNumber,
            room.raising_state,
            Math.max(1, room.mates.length),
            getShareNowMs(),
        )
    } catch (error) {
        console.warn("[SOCIAL-SHARE] room share sync failed", roomNumber, error)
    }
}

/** 解散钩子：删除注册行（尽力而为，不阻断解散主流程） */
export function deleteRoomShareRowForDisband(roomNumber: string): void {
    try {
        const { deleteRoomShareRowSync } = require("../../data/domains/social-room-shares") as typeof import("../../data/domains/social-room-shares")
        deleteRoomShareRowSync(roomNumber)
    } catch (error) {
        console.warn("[SOCIAL-SHARE] room share disband cleanup failed", roomNumber, error)
    }
}

function getShareNowMs(): number {
    // 与 attention/social_room_shares 写入侧同一时钟（getServerTime，受全局
    // timeOffset）——expires_at 比较两侧必须同源
    const { getServerTime } = require("../../utils") as typeof import("../../utils")
    return getServerTime() * 1000
}
