import {
    refreshRoomShareRowAsync,
} from "../../data/domains/social-room-shares"
import { describeError } from "../describe-error"

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
    // W1a：内部异步、对外 fire-and-forget——调用点（TCP 断连/房间钩子）是
    // 同步上下文，注册表是显示/发现数据，失败 WARN 不阻断主流程
    void (async () => {
        const { getRoom } = require("./manager") as typeof import("./manager")
        const room = getRoom(roomNumber)
        if (!room) return
        await refreshRoomShareRowAsync(
            roomNumber,
            room.raising_state,
            Math.max(1, room.mates.length),
            getShareNowMs(),
        )
    })().catch(error => {
        console.warn("[SOCIAL-SHARE] room share sync failed", roomNumber, describeError(error))
    })
}

/**
 * share_room 的注册行公开（HTTP 层门面）：房间权威节点内读 mates/raising_state
 * 并落 upsert。HTTP 层不 import room manager（架构守卫），统一经此入口。
 * 失败由调用方 WARN 降级（无重发自愈的一次性报文，靠用户重新勾选恢复）。
 */
export function openRoomShareRow(input: {
    readonly roomNumber: string
    readonly hostViewerId: number
    readonly categoryId: number
    readonly questId: number
    readonly shareBits: number
    readonly establisherJson: string
}): void {
    // W1a：fire-and-forget 同上（HTTP 调用方为 async handler，但门面保持
    // 同步签名让 TCP/HTTP 两侧调用点形状统一）
    void (async () => {
        const { getRoom } = require("./manager") as typeof import("./manager")
        const { upsertRoomShareRowAsync } = require("../../data/domains/social-room-shares") as typeof import("../../data/domains/social-room-shares")
        const room = getRoom(input.roomNumber)
        await upsertRoomShareRowAsync({
            roomNumber: input.roomNumber,
            hostViewerId: input.hostViewerId,
            categoryId: input.categoryId,
            questId: input.questId,
            shareBits: input.shareBits,
            raisingState: room?.raising_state ?? 2,
            mates: Math.max(1, room?.mates.length ?? 1),
            establisherJson: input.establisherJson,
            nowMs: getShareNowMs(),
        })
    })().catch(error => {
        console.warn("[SOCIAL-SHARE] room share open failed", input.roomNumber, describeError(error))
    })
}

/** 解散钩子：删除注册行（尽力而为，不阻断解散主流程） */
export function deleteRoomShareRowForDisband(roomNumber: string): void {
    void (async () => {
        const { deleteRoomShareRowAsync } = require("../../data/domains/social-room-shares") as typeof import("../../data/domains/social-room-shares")
        await deleteRoomShareRowAsync(roomNumber)
    })().catch(error => {
        console.warn("[SOCIAL-SHARE] room share disband cleanup failed", roomNumber, describeError(error))
    })
}

function getShareNowMs(): number {
    // R-15=B：基础设施 TTL（房间招募行寿命）锚定真实时间——虚拟时间轴属于
    // 内容排期，timeOffset 调整不得使招募行瞬时全灭或永不过期。
    // 写入侧（attention/social_room_shares）与读取侧（本函数、lobby 列表）
    // 同步改锚，两侧同源。
    const { getRealNowMs } = require("../../runtime/time/game-time") as typeof import("../../runtime/time/game-time")
    return getRealNowMs()
}
