export function resolveIsRoomHost(params: {
    roomHostPlayerId: number | null
    playerId: number
}): boolean {
    return params.roomHostPlayerId !== null
        && params.roomHostPlayerId === params.playerId
}

export function resolveHostFinished(params: {
    previouslyHostFinished: boolean
    questAccomplished: boolean
    isRoomHost: boolean
}): boolean {
    return params.previouslyHostFinished
        || (params.questAccomplished && params.isRoomHost)
}
