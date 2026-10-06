import { getRoom } from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import { advanceRecruitmentGeneration } from "../tcp/lobby"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"

/**
 * NPC 识别：comId > 0（全仓约定——真人条目无 comId，见 countRealPlayers/
 * selectRealMates/limitLobbyMates）。不要用 viewerId 区间判断：真人 viewerId
 * 由 generateViewerId 在 [1e8, 999999998] 随机，与 NPC 合成区间 [9e8, ...] 重叠。
 */
function isNpcMate(mate: { comId?: number | null }): boolean {
    return (mate.comId ?? 0) > 0
}

/**
 * 一场一换的一代一闩：同一 battleSessionId 只清一次。
 * finalize 重试 / abort-after-finalize 会在 30min fact 窗口内携带同一
 * battleSessionId 重入 releaseBattle——没有本闩时，rematch 重建的新一代编队
 * 会被迟到重入误清。新一代战斗有新 session id，释放时正常清除。
 * 每房一条，进程生命周期内存有界。
 */
const clearedBattleSessions = new Map<string, string>()

/**
 * 一场一换（三模式参数 npcLifecycle=one-shot）：战斗 release 回房时撤除 NPC 编队。
 *
 * 清除原子面（设计 v2 §4，双审定案 6 项——漏任一会经 limitLobbyMates 复活幽灵 NPC
 * 并可能带鬼自动开局）：
 *  1. room.npc_count → 0
 *  2. hostClient.mates 过滤（权威 mates 列表在此，不在 room）
 *  3. 每个 roomClient.mates 投影同步过滤
 *  4. room.mates 重算（serializer 的 room_member_count/mates 直取此值）
 *  5. advanceRecruitmentGeneration（防 straggler 定时器）
 *  6. broadcastMateListToRoom（复用真人离开同款全量 mates 推送）
 *
 * 设置在事件点读取（默认 persistent = no-op）。尽力而为：任何失败只告警，
 * 绝不破坏 finalize 主流程。hostClient 缺席（战斗中掉线宽限期）时仅清
 * room.mates 与 npc_count，客户端视图由回房 Enter 以服务端状态重建。
 */
export function clearRoomNpcRoster(roomNumber: string, battleSessionId?: string): void {
    try {
        if (!getServerGameplaySettingsSync().multiNpcOneShotLifecycle) return
        const room = getRoom(roomNumber)
        if (!room || (room.npc_count <= 0 && !room.is_npc_mode)) return

        // 一代一闩：同战斗会话的重入直接跳过，防误清 rematch 新一代编队；
        // 无战斗身份（node-session 清扫等）落空串闩
        const latchKey = battleSessionId ?? ""
        if (clearedBattleSessions.get(roomNumber) === latchKey) return
        clearedBattleSessions.set(roomNumber, latchKey)

        room.npc_count = 0
        advanceRecruitmentGeneration(room)

        const hostClient = sessionManager.getRoomHostClient(roomNumber)
        if (hostClient) {
            hostClient.mates = hostClient.mates.filter(mate => !isNpcMate(mate))
            room.mates = hostClient.mates.map(mate => ({
                viewer_id: mate.viewerId ?? null,
                com_id: mate.comId ?? 0,
            }))
            for (const client of sessionManager.getClientsInRoom(roomNumber)) {
                client.mates = client.mates.filter(mate => !isNpcMate(mate))
            }
            sessionManager.broadcastMateListToRoom(roomNumber, hostClient.mates)
        } else {
            // 无 host 连接：房内权威视图直接过滤，客户端视图待回房重建
            room.mates = room.mates.filter(mate => (mate.com_id ?? 0) <= 0)
        }
        console.log(`[MULTI] one-shot NPC roster cleared: room=${roomNumber}`)
    } catch (error) {
        console.warn(`[MULTI] one-shot NPC roster clear failed: room=${roomNumber}`, error)
    }
}
