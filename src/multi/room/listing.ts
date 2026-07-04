import { getQuestFromCategorySync } from "../../lib/assets"
import { MultiRoom } from "../../lib/types"

const MAX_ROOM_MATES = 3

function getRoomEventId(room: MultiRoom): number | undefined {
    const quest = getQuestFromCategorySync(room.category, room.quest_id)
    return quest?.eventId
}

export function isRoomJoinableForList(room: MultiRoom): boolean {
    return room.raising_state !== 4 && room.mates.length < MAX_ROOM_MATES
}

export function roomMatchesListFilter(room: MultiRoom, categoryId: number, eventId?: number): boolean {
    if (room.category !== categoryId) return false
    if (!isRoomJoinableForList(room)) return false
    if (eventId === undefined || eventId === null) return true

    return getRoomEventId(room) === eventId
}

export function filterRoomsForList(rooms: MultiRoom[], categoryId: number, eventId?: number): MultiRoom[] {
    return rooms.filter((room) => roomMatchesListFilter(room, categoryId, eventId))
}
