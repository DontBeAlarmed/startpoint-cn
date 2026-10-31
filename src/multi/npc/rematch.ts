// 切片 2 步 2c.2:NPC 续战回房(NPC=玩家同构)。
// npcRematchEnabled 是 NPC 自己的续战开关(默认 ON,与玩家的续战设置同构):
// ON = 每场 4→1 后 NPC 像开了续战的真人一样自动回房(虚拟 admit/handshake/
// enter,与回房真人先到先得,内核仲裁);OFF = 战斗结束离场(roster 由
// clearRoomNpcRoster 清空,见 one-shot 路径)。
// 房主重入不触发本逻辑(补位唯一入口=房主手动铃铛招募;此处是 NPC 自己的
// 续战,不是补位)。
// 抢输处理:admit 被拒(真人先到)→ NPC 保持 roster 条目不销毁——条目是
// 本房间 NPC 名册(身份/昵称),座位竞争输了下次续战再试;enter 被拒
// (理论不可达,admit 已锁定名额)→ 防御性销毁。

import { getRoom } from "../room/manager"
import { lifecycleRegistry } from "../lifecycle"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"
import { getRealNowMs } from "../../runtime/time/game-time"
import { npcIdentityOf } from "./identity"
import type { RoomNpcAssignment } from "../../lib/types"

export function returnNpcRosterAfterHostReturn(roomNumber: string): void {
    const room = getRoom(roomNumber)
    if (!room) return
    // fail-open:设置域不可读(无 DB 的轻量进程)时按默认 ON 处理
    let rematchEnabled = true
    try {
        rematchEnabled = getServerGameplaySettingsSync().npcRematchEnabled
    } catch {
        rematchEnabled = true
    }
    if (!rematchEnabled) return
    const state = lifecycleRegistry.get(roomNumber)
    if (!state || state.phase !== "ready") return
    let seatedCount = 0
    for (const assignment of [...room.npc_roster] as RoomNpcAssignment[]) {
        const identity = npcIdentityOf(roomNumber, assignment.com_id)
        if (state.seats.includes(identity)) continue
        const admit = lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "admit", generation, identity,
        }))
        if (!admit || admit.rejected !== undefined) continue
        lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "handshake", generation, identity,
        }))
        const enter = lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "enter", generation, identity, nowMs: getRealNowMs(),
        }))
        if (!enter || enter.rejected !== undefined) {
            const index = room.npc_roster.indexOf(assignment)
            if (index >= 0) room.npc_roster.splice(index, 1)
            continue
        }
        assignment.viewer_id = assignment.viewer_id ?? (900000000 + assignment.com_id)
        assignment.ready = true
        seatedCount += 1
    }
    if (seatedCount === 0) return
    console.log(`[MULTI] npc rematch return: room=${roomNumber} seated=${seatedCount}`
        + ` roster=${room.npc_roster.length}`)
    // 投影重建 + ready 帧 + auto-ready:仅在房主 client 存在时执行——
    // 内核入座已完成,缺席时由房主随后的 TCP enter 的无条件投影重建兜底
    //(2026-11-01 真机教训:此守卫曾放在入座之前,开战瞬间房主大厅 socket
    // 已关 → 4→1 时点 hostClient=undefined → 整个回房被误杀,直到房主
    // 下一次状态轮询才触发——表现为"NPC 等另一名玩家返回才出现")。
    // lobby 内部函数经惰性 require 引入(本模块被 embedded 持有,避免加载环)。
    const lobby = require("../tcp/lobby") as typeof import("../tcp/lobby")
    const { sessionManager } = require("../state/SessionManager") as typeof import("../state/SessionManager")
    const hostClient = sessionManager.getRoomHostClient(roomNumber)
    if (!hostClient) return
    const projected = lobby.projectRoomMatesFromKernel(roomNumber, hostClient)
    hostClient.mates = projected
    room.mates = projected.map(mate => ({ viewer_id: mate.viewerId ?? null, com_id: mate.comId ?? 0 }))
    lobby.broadcastReadyFramesForSeatedNpcs(roomNumber, projected)
    lobby.checkHostAutoReady(roomNumber)
}
