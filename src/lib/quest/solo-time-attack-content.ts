import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"

/**
 * 极时试炼(solo_time_attack)时间线奖励的只读查询。
 * 数据源:CN 主数据 quest/event/solo_time_attack_clear_time_reward
 * (客户端 SoloTimeAttackClearTimeRewardValues 列序权威):
 *   col0=display_order / col1=event_id / col2=quest_id / col3=名称 /
 *   col4=clear_time_seconds / col5=mail reason_id /
 *   col6=reward1_kind("2"=Stone) / col7=reward1_id / col8=reward1_number ...
 * CN 1.4.54:全 222 行奖励均为 Stone(星导石),单奖励槽。
 */
export type SoloTimeAttackTierReward =
    | Readonly<{ kind: "stone", count: number }>
    | Readonly<{ kind: "degree", degreeId: number, count: number }>

export interface SoloTimeAttackTimelineTier {
    readonly id: number
    readonly eventId: number
    readonly questId: number
    readonly name: string
    readonly clearTimeSeconds: number
    readonly mailReasonId: number
    readonly rewards: readonly SoloTimeAttackTierReward[]
}

const tiersByRepository = new WeakMap<ReadonlyContentRepository, readonly SoloTimeAttackTimelineTier[]>()

function parseRows(value: unknown): readonly (readonly string[])[] {
    if (!Array.isArray(value)) return []
    return (Array.isArray(value[0]) ? value : [value]) as readonly (readonly string[])[]
}

function parseInteger(tableName: string, value: unknown, field: string): number {
    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`solo_time_attack_clear_time_reward: ${tableName} ${field} is not an integer: ${String(value)}`)
    }
    return parsed
}

export function getSoloTimeAttackTimelineTiers(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): readonly SoloTimeAttackTimelineTier[] {
    const cached = tiersByRepository.get(repository)
    if (cached !== undefined) return cached
    let raw: Record<string, unknown>
    try {
        raw = repository.table("solo_time_attack_clear_time_reward.json") as unknown as
            Record<string, unknown>
    } catch {
        // 旧内容快照无此表:时间线奖励通道整体缺位,按空集处理
        return Object.freeze([])
    }
    const tiers: SoloTimeAttackTimelineTier[] = []
    for (const rows of Object.values(raw)) {
        for (const row of parseRows(rows)) {
            const rewards: SoloTimeAttackTierReward[] = []
            // 奖励槽:col6 起每 3 列一组(kind/id/number),CN 数据含 Stone(2)
            // 与 Degree(7,称号)两类;其余类别 fail-close
            for (let base = 6; base + 2 < row.length; base += 3) {
                const kind = row[base]
                if (!kind || kind === "(None)") continue
                if (kind === "2") {
                    rewards.push({ kind: "stone", count: parseInteger("reward.number", row[base + 2], `slot${base}`) })
                } else if (kind === "7") {
                    rewards.push({
                        kind: "degree",
                        degreeId: parseInteger("reward.id", row[base + 1], `slot${base}`),
                        count: parseInteger("reward.number", row[base + 2], `slot${base}`),
                    })
                } else {
                    throw new Error(`solo_time_attack_clear_time_reward: unsupported reward kind ${String(kind)}`)
                }
            }
            tiers.push({
                id: parseInteger("display_order", row[0], "display_order"),
                eventId: parseInteger("event_id", row[1], "event_id"),
                questId: parseInteger("quest_id", row[2], "quest_id"),
                name: String(row[3] ?? ""),
                clearTimeSeconds: parseInteger("clear_time_seconds", row[4], "clear_time_seconds"),
                mailReasonId: parseInteger("reason_id", row[5], "reason_id"),
                rewards: Object.freeze(rewards),
            })
        }
    }
    tiersByRepository.set(repository, Object.freeze(tiers))
    return tiers
}

/** 指定事件+任务的分期时间线,按通关门槛降序(严→宽)。 */
export function resolveSoloTimeAttackTimelineTiers(
    eventId: number,
    soloQuestId: number,
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): readonly SoloTimeAttackTimelineTier[] {
    const all = getSoloTimeAttackTimelineTiers(repository)
    const resolved = all
        .filter(tier => tier.eventId === eventId && tier.questId === soloQuestId)
        .sort((left, right) => left.clearTimeSeconds - right.clearTimeSeconds)
    if (resolved.length === 0) {
        // 2026-11-11 真机诊断:79.7s 通关零发放——tableRows>0 且仍空=(event,quest)
        // 过滤口径问题;tableRows=0=表缺失/解析空(优雅降级吞错后的可见性)
        console.log(`[SOLO_TA] tiers empty: event=${eventId} quest=${soloQuestId}`
            + ` tableRows=${all.length}`)
    }
    return resolved
}
