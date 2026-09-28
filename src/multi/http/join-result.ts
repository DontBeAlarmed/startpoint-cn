import type {
    CoordinatorErrorCode,
    CoordinatorResult,
} from "../coordinator/contracts"
import type { RoomStatus } from "../coordinator/interface"
import type { MultiQuestAvailabilityProvider } from "./context"

type JoinUnavailableError = Exclude<CoordinatorErrorCode, "ROOM_NOT_FOUND">

export type RoomJoinResult =
    | { readonly kind: "available"; readonly value: RoomStatus }
    | { readonly kind: "missing"; readonly error: "ROOM_NOT_FOUND" }
    | { readonly kind: "unavailable"; readonly error: JoinUnavailableError }

export function roomUnavailableRaisingState(
    error: CoordinatorErrorCode,
): 3 | 7 | 9 {
    if (error === "ROOM_NOT_FOUND") return 9
    if (error === "ROOM_FULL") return 3
    return 7
}

/**
 * CN 1.8.1 MultiBattleQuestPrepareRealRemote 仅接受 raising_state 1/2/9；
 * 3/4/7/8/10/11/12/13 会让客户端抛 ClientError 5001。除 ROOM_NOT_FOUND(→9)
 * 外的一切失败都必须走 A-error 通道（调用方回 result_code 4507 → Failure）。
 */
export function prepareFailureRaisingState(
    error: CoordinatorErrorCode,
): 9 | null {
    return error === "ROOM_NOT_FOUND" ? 9 : null
}

/**
 * CN 1.8.1 MultiBattleQuestRestoreRoomRealRemote：9=Disbanded、13=NotMate；
 * 除房间不存在外的失败按 13 处理。
 */
export function restoreRoomUnavailableRaisingState(
    error: CoordinatorErrorCode,
): 9 | 13 {
    return error === "ROOM_NOT_FOUND" ? 9 : 13
}

export function classifyRoomJoin(
    questAvailability: MultiQuestAvailabilityProvider,
    result: CoordinatorResult<RoomStatus>,
): RoomJoinResult {
    if (!result.ok) return result.error === "ROOM_NOT_FOUND"
        ? { kind: "missing", error: result.error }
        : { kind: "unavailable", error: result.error }
    return questAvailability.check(result.value.category, result.value.questId).available
        ? { kind: "available", value: result.value }
        : { kind: "unavailable", error: "QUEST_NOT_AVAILABLE" }
}
