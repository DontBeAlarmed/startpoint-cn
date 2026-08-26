export interface DeviceBinding {
    deviceId: number
    name: string | null
}

export interface PlayerBrief {
    id: number
    accountId: number
    name: string
    rank: number
    isDefault: boolean
    isActive: boolean
}

export interface AccountRow {
    id: number
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    activePlayerId: number | null
    devices: DeviceBinding[]
    players: PlayerBrief[]
    playerIds: number[]
}
