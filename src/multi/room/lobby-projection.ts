import { getRoom } from "./manager"
import { sessionManager } from "../state/SessionManager"

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
 */
export function projectLobbyRaisingState(
    roomNumber: string,
    hostViewerId: number,
    registryState: number,
): number {
    const room = getRoom(roomNumber)
    if (!room) return registryState
    if (room.raising_state === 4) return 4
    if (!sessionManager.isUniqueRoomViewerOnline(hostViewerId, roomNumber)) return 2
    return room.raising_state
}
