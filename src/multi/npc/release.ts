import { getRoom } from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import { scheduleLobbyTask, type LobbyLifecycleGuard } from "../tcp/lobby-lifecycle"
import { handleEnterComs } from "../tcp/lobby"
import {
    closeRecruitmentForRoom,
    findOpenRecruitmentForRoom,
    getRecruitmentLifetimeMs,
    refreshRecruitmentForRoom,
} from "../../data/domains/attention"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"
import { getServerTime } from "../../utils"

/**
 * 私服混合的窗口释放点（设计 v2 §3「服务端注入」）：客户端每场景只发一次 summon
 * （Faild/Summoned 终态），纯 summon 路径无法实现 W>20s 的真窗口——由服务端在
 * 招募发布后挂惰性释放点，到点直接经 handleEnterComs 注入 NPC。
 *
 * 纪律（设计 §7 规则 1 + 收官审查 A2）：
 * - 释放回调内重读配置：未到点按剩余时间经 scheduleLobbyTask 重挂，W 热切换天然生效
 * - 重复调度抑制：同房间在途释放点唯一（Map 去重）
 * - 守卫：招募行活性重锚（过期/关闭/换行即放弃）、hostClient 存在、
 *   开战锁（handleEnterComs 自带 raising_state===4 拒绝）
 */
const pendingReleases = new Map<string, true>()

/** 保持到点判定的最小重挂粒度：小于该值视为已到点，直接尝试注入 */
const RESCHEDULE_FLOOR_MS = 1_000

export function scheduleNpcRelease(roomNumber: string): void {
    try {
        const settings = getServerGameplaySettingsSync()
        if (!settings.multiRandomRecruitmentPublishEnabled || settings.multiNpcReleaseSeconds <= 0) return
        if (pendingReleases.has(roomNumber)) return
        if (!scheduleLobbyTask(lifecycle => {
            pendingReleases.delete(roomNumber)
            try {
                fireOrReschedule(lifecycle, roomNumber)
            } catch (error) {
                console.warn(`[MULTI] npc release failed: room=${roomNumber}`, error)
            }
        }, getServerGameplaySettingsSync().multiNpcReleaseSeconds * 1000)) {
            return // lobby lifecycle 未启动（如纯内存测试）：跳过，summon 路径不受影响
        }
        pendingReleases.set(roomNumber, true)
    } catch (error) {
        console.warn(`[MULTI] npc release schedule failed: room=${roomNumber}`, error)
    }
}

export function resetNpcReleaseState(): void {
    pendingReleases.clear()
}

function fireOrReschedule(lifecycle: LobbyLifecycleGuard, roomNumber: string): void {
    const settings = getServerGameplaySettingsSync()
    if (!settings.multiRandomRecruitmentPublishEnabled || settings.multiNpcReleaseSeconds <= 0) return
    const room = getRoom(roomNumber)
    if (!room) return
    const nowMs = getServerTime() * 1000
    // 活性重锚：优先取未过期 open 行；仅 status='open' 但已过期（客户端重发停摆，
    // 而非招募关闭）时服务端接管——视为到点继续注入（双审 B-3 退化分支）
    let recruitment = findOpenRecruitmentForRoom(room.host_viewer_id, roomNumber, nowMs)
    if (recruitment === null) {
        recruitment = findOpenRecruitmentForRoom(room.host_viewer_id, roomNumber, nowMs, true)
    }
    if (recruitment === null) return // 行关闭/缺失（解散/开战/清扫）：放弃

    const remainingMs = recruitment.postedAtMs + settings.multiNpcReleaseSeconds * 1000 - nowMs
    if (remainingMs > RESCHEDULE_FLOOR_MS) {
        // W 被调长（或新行换了起点）：按剩余时间重挂，配置热切换天然生效
        if (scheduleLobbyTask(nextLifecycle => {
            pendingReleases.delete(roomNumber)
            try {
                fireOrReschedule(nextLifecycle, roomNumber)
            } catch (error) {
                console.warn(`[MULTI] npc release retry failed: room=${roomNumber}`, error)
            }
        }, remainingMs)) {
            pendingReleases.set(roomNumber, true)
        }
        return
    }

    const hostClient = sessionManager.getRoomHostClient(roomNumber)
    if (!hostClient) {
        console.log(`[MULTI] npc release skipped (host offline): room=${roomNumber}`)
        return
    }
    void handleEnterComs(hostClient, lifecycle).catch(error => {
        console.error(`[MULTI] npc release inject failed: room=${roomNumber}`, error)
    })
}

/**
 * postFill（设计 §3）：NPC 进场提交后的招募行处置。
 * close（官服）：NPC 是终点 → 关招募；keep-open（私服）：NPC 是占位 →
 * 服务端接管行寿命（客户端进战后停铃，不接管则 45s 静默失效）。
 * 由 handleEnterComs 提交点调用（双审定案：挂 commit 而非 summon 响应）。
 */
export function applyNpcPostFill(roomNumber: string): void {
    try {
        const settings = getServerGameplaySettingsSync()
        const room = getRoom(roomNumber)
        if (!room) return
        const nowMs = getServerTime() * 1000
        if (settings.multiNpcCloseRecruitmentAfterFill) {
            closeRecruitmentForRoom(room.host_viewer_id, roomNumber)
        } else if (settings.multiRandomRecruitmentPublishEnabled) {
            refreshRecruitmentForRoom(room.host_viewer_id, roomNumber, nowMs, getRecruitmentLifetimeMs())
        }
    } catch (error) {
        console.warn(`[MULTI] npc post-fill bookkeeping failed: room=${roomNumber}`, error)
    }
}
