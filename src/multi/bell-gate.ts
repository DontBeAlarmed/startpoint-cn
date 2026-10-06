import { getRoom } from "./room/manager"
import { sessionManager } from "./state/SessionManager"

/**
 * T1 投递资格门（设计 v2 §5，同节点房间态检查，check 投递谓词的插槽）：
 * 房间在本节点可见时校验——未开战/启动中、房主在线、真人未满员；
 * 房间不在本节点（多节点部署下其他节点持有）→ 放行（45s 有界生命周期兜底）。
 * 占用只数真人（comId 判别，全仓约定）——keep-open 下 NPC 占位不挡真人。
 */
export function isBellDeliveryEligible(roomNumber: string): boolean {
    const room = getRoom(roomNumber)
    if (!room) return true
    if (room.raising_state === 4) return false
    const hostClient = sessionManager.getRoomHostClient(roomNumber)
    if (!hostClient) return false
    const realMembers = hostClient.mates.filter(mate => !mate.comId).length
    return realMembers < 3
}
