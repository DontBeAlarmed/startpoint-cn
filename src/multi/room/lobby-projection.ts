import { getRoom } from "./manager"
import { sessionManager } from "../state/SessionManager"
import { projectRaisingStateForViewer } from "./raising-state-projection"

/**
 * 大厅条目 raising_state 投影（F2）：本节点房间以活房间状态为权威，房主
 * lobby socket 不在线时投影为 2（Waiting，客户端原生灰显）——与 select_room
 * 的 host-offline→2 覆盖同语义。TCP 静默死亡的房间在注册行可能仍挂着
 * 1/Ready，不投影会让客人点进一个必败房间。战斗中（4）恒直通：房主 lobby
 * 连接本就已切换为 battle socket，按离线投影会把活战斗错报成 Waiting。
 * 异节点行（getRoom 为空）信任注册值——权威节点上的钩子负责同步。
 *
 * 放在 multi/room 而非 http 路由文件：路由层依赖注入的 coordinator，
 * 不直接触全局 room manager（multi_room_identity 架构契约）。
 * 决策表统一收敛在 raising-state-projection（切片 1 第②步）；本函数只负责
 * 本节点房间解析与 hostOnline 的活 socket 判定来源。
 */
export function projectLobbyRaisingState(
    roomNumber: string,
    hostViewerId: number,
    registryState: number,
): number {
    const room = getRoom(roomNumber)
    if (!room) return registryState
    return projectRaisingStateForViewer({
        state: room.raising_state,
        isHost: false,
        isMember: false,
        hostOnline: sessionManager.isUniqueRoomViewerOnline(hostViewerId, roomNumber),
        flow: "list",
    }).raisingState
}
