import { getCharactersEvolutionImgLevels } from "../lib/character"

// 联机展示字段的 fail-open 包装：进化等级实查依赖内容快照（角色进化表），
// 快照未初始化（无内容 stub 环境）会抛 CONTENT_SNAPSHOT_NOT_INITIALIZED——
// 把纯展示字段的读取失败降级为 0，不阻断房间加入/铃铛投递主流程。

export function safeEvolutionImgLevel(playerId: number, characterId: number): number {
    try {
        return getCharactersEvolutionImgLevels(playerId, [characterId])[0] ?? 0
    } catch {
        return 0
    }
}
