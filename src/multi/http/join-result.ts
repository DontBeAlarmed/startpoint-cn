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
