// 2a1：NPC 参与者的域内身份。npc:<roomNumber>:<comId>——com_id 每房稳定
// （1/2），身份可从 room+comId 纯推导，roster 无需持久化身份字段。
// 900000000 段合成 viewerId 只活在 serializer/mates 投影层，不是域内身份。

export function npcIdentityOf(roomNumber: string, comId: number): string {
    return `npc:${roomNumber}:${comId}`
}

export function isNpcIdentity(identity: string): boolean {
    return identity.startsWith("npc:")
}
