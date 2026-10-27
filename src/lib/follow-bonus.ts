import {
    getCoopBonusCountsSync,
    incrementCoopBonusCountsSync,
} from "../data/domains/social-follow"

/**
 * 关注奖励（multi_battle_quest/start 响应的 follow_bonus_info）。
 *
 * 语义（v4 冻结规格）：值 = 与该好友的共斗累计奖励分（每局 +10，即
 * "第几把"×10），按方向行独立记账——A 关注 B 就能看到与 B 的计数，
 * 与 B 是否回关无关；取关删行即清零，重关注从 0 起。
 *
 * 客户端消费（1.8.1 反编译）：start 响应 follow_bonus_info 为可选数组，
 * 每条 {viewer_id, follow_bonus_list: Map<viewerId,Float>, total_follow_bonus}；
 * 仅多人战消费——total 计入最终 score（FinalScore total += totalFollowBonus），
 * 结算画面逐人显示 list（MateFollowInfoFormatter 按 viewer_id 查表，
 * key = 十进制字符串）。分数链路自洽：加成进 score 上报 finish，
 * 服务端分数报酬逻辑自动包含，无二次计算。
 *
 * 时序：start 响应先于 TCP StartBattle（增量点），故显示值 = 计数 + 10
 * 预支本局；全员 StartBattle 前放弃的局显示多记一次——纯显示级瑕疵。
 */

const FOLLOW_BONUS_PER_BATTLE = 10
const FOLLOW_BONUS_VALUE_CAP = 1_000_000

export interface FollowBonusInfo {
    /** 本条记录归属的查看者 viewer id（客户端按自身 id 取条目） */
    readonly viewerId: number
    /** {好友 viewerId(十进制字符串): 累计奖励分（含本局预支）} */
    readonly followBonusList: Readonly<Record<string, number>>
    /** 合计（= list 值之和，钳上限）；客户端把它加进本局 score */
    readonly totalFollowBonus: number
}

/**
 * 构建 start 响应的 follow_bonus_info 条目；无任何关注边时返回 null
 * （整个字段省略——客户端 Option.None → 0，与无功能时完全一致）。
 * 读取/构建失败 fail-open 为 null（纯奖励字段不得影响开战）。
 */
export function buildFollowBonusInfo(
    viewerId: number,
    mateViewerIds: readonly number[],
): FollowBonusInfo | null {
    try {
        const counts = getCoopBonusCountsSync(viewerId, mateViewerIds)
        const list: Record<string, number> = {}
        let total = 0
        for (const mateId of mateViewerIds) {
            const count = counts[mateId]
            if (count === undefined) continue // 无关注边：不显示、不计数
            const value = Math.min(count + FOLLOW_BONUS_PER_BATTLE, FOLLOW_BONUS_VALUE_CAP)
            list[String(mateId)] = value
            total += value
        }
        if (Object.keys(list).length === 0) return null
        return {
            viewerId,
            followBonusList: list,
            totalFollowBonus: Math.min(total, FOLLOW_BONUS_VALUE_CAP),
        }
    } catch (error) {
        console.warn("[FOLLOW_BONUS] build failed (field omitted)", error)
        return null
    }
}

/**
 * 开战记账：对本局真实成员间每条已存在的关注方向行 +10（单事务，钳上限）。
 * 在 TCP StartBattle 提交边界调用（每局恰好一次）；无边的有序对静默跳过。
 * 失败仅告警——记账缺失只影响下一局的显示基数，不得影响开战提交。
 */
export function incrementFollowBonusForBattle(memberViewerIds: readonly number[]): void {
    try {
        const members = [...new Set(memberViewerIds)]
        const pairs: { followerViewerId: number; followedViewerId: number }[] = []
        for (const follower of members) {
            for (const followed of members) {
                if (follower !== followed) {
                    pairs.push({ followerViewerId: follower, followedViewerId: followed })
                }
            }
        }
        incrementCoopBonusCountsSync(pairs)
    } catch (error) {
        console.warn("[FOLLOW_BONUS] battle increment failed", error)
    }
}
