export function resolveIsRoomHost(params: {
    roomHostPlayerId: number | null
    playerId: number
}): boolean | undefined {
    if (params.roomHostPlayerId === null) return undefined
    return params.roomHostPlayerId === params.playerId
}

export function resolveHostFinished(params: {
    previouslyHostFinished: boolean
    questAccomplished: boolean
    isRoomHost: boolean | undefined
}): boolean {
    return params.previouslyHostFinished
        || (params.questAccomplished && params.isRoomHost === true)
}
