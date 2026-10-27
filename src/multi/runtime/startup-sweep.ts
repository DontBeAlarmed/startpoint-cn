import { closeAllOpenRecruitments } from "../../data/domains/attention"
import { purgeAllRoomShareRowsSync } from "../../data/domains/social-room-shares"
import { isSharedSocialDbConfigured } from "../../data/social/shared-db"
import { describeError } from "../describe-error"
import { listActiveRooms } from "../room/manager"

/**
 * 启动清扫（进程重启的幽灵房根治）：房间与其 TCP 会话只存在于进程内存，
 * 随进程消亡；但好友大厅注册行（social_room_shares，TTL 30 分钟）与铃铛
 * 招募行（TTL 45 秒）持久在 SQLite——重启后它们指向必败的幽灵房，客人
 * 在 TTL 窗口内会看到"可加入"的房、点进去 raising_state=9，且大厅刷新
 * 不会自行清除（N7 投影对 getRoom 未命中信任注册值，多节点语义）。
 *
 * 本地权威部署（embedded/host，且未配置共享社交库）：本节点启动时内存
 * 必然无存活房间，本地库中的注册/招募行全部为上一进程的孤儿——直接
 * 清除。共享社交库（多节点等权）部署不扫：本节点启动无权判定其他节点
 * 的行，仍由 TTL 兜底。
 *
 * 防御：若调用时内存中已有存活房间（非启动态），跳过清扫——绝不碰活数据。
 */
export function purgeOrphanedSocialRowsForLocalAuthority(): void {
    if (listActiveRooms().length > 0) {
        console.warn("[MULTI] startup sweep skipped: live rooms present (non-boot invocation)")
        return
    }
    if (isSharedSocialDbConfigured()) {
        console.log("[MULTI] startup sweep skipped: shared social db configured (multi-node)")
        return
    }
    try {
        closeAllOpenRecruitments()
    } catch (error) {
        console.warn(`[MULTI] startup sweep: recruitment close failed: ${describeError(error)}`)
    }
    try {
        const purged = purgeAllRoomShareRowsSync()
        console.log(`[MULTI] startup sweep: purged ${purged} orphaned room share row(s)`)
    } catch (error) {
        console.warn(`[MULTI] startup sweep: share row purge failed: ${describeError(error)}`)
    }
}
