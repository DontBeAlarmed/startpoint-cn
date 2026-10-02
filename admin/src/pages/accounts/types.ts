export interface DeviceBinding {
    deviceId: number
    name: string | null
}

export interface PlayerBrief {
    id: number
    accountId: number
    name: string
    rank: number
    characterCount: number
    lastLoginTime: string
    isDefault: boolean
    isActive: boolean
    // 只读投影: 游戏内收藏编队第一个非空角色位（存档子卡喜爱角色头像）; null = 无
    favoriteCharacterId: number | null
}

export interface AccountRow {
    id: number
    adminNote: string | null
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    activePlayerId: number | null
    devices: DeviceBinding[]
    players: PlayerBrief[]
    playerIds: number[]
}
