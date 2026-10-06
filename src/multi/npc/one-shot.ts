import { getRoom } from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import { advanceRecruitmentGeneration } from "../tcp/lobby"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"

/**
 * NPC viewer 合成空间：EnterComs 以 900000000+com_id 分配（tcp/lobby.ts），
 * 真人 viewer 不会落入该区间——一场一换以此 + comId 标记识别 NPC 条目。
 */
const NPC_VIEWER_ID_FLOOR = 900_000_000

function isNpcMate(mate: { viewerId?: number | null; comId?: number | null }): boolean {
    return (mate.comId ?? 0) > 0 || (mate.viewerId ?? 0) >= NPC_VIEWER_ID_FLOOR
}

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
export function clearRoomNpcRoster(roomNumber: string): void {
    try {
        if (!getServerGameplaySettingsSync().multiNpcOneShotLifecycle) return
        const room = getRoom(roomNumber)
        if (!room || (room.npc_count <= 0 && !room.is_npc_mode)) return

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
            room.mates = room.mates.filter(mate => {
                const viewerId = mate.viewer_id ?? 0
                const comId = mate.com_id ?? 0
                return comId <= 0 && viewerId < NPC_VIEWER_ID_FLOOR
            })
        }
        console.log(`[MULTI] one-shot NPC roster cleared: room=${roomNumber}`)
    } catch (error) {
        console.warn(`[MULTI] one-shot NPC roster clear failed: room=${roomNumber}`, error)
    }
}
