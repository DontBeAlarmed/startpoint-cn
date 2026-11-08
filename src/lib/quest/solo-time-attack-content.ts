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
export interface SoloTimeAttackTimelineTier {
    readonly id: number
    readonly eventId: number
    readonly questId: number
    readonly name: string
    readonly clearTimeSeconds: number
    readonly mailReasonId: number
    readonly stoneCount: number
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
            const kind = row[6]
            if (kind !== "2") {
                // CN 1.4.54 数据全部为 Stone;出现其他类别即内容漂移,fail-close
                throw new Error(`solo_time_attack_clear_time_reward: unsupported reward kind ${String(kind)}`)
            }
            tiers.push({
                id: parseInteger("display_order", row[0], "display_order"),
                eventId: parseInteger("event_id", row[1], "event_id"),
                questId: parseInteger("quest_id", row[2], "quest_id"),
                name: String(row[3] ?? ""),
                clearTimeSeconds: parseInteger("clear_time_seconds", row[4], "clear_time_seconds"),
                mailReasonId: parseInteger("reason_id", row[5], "reason_id"),
                stoneCount: parseInteger("reward1_number", row[8], "reward1_number"),
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
    return getSoloTimeAttackTimelineTiers(repository)
        .filter(tier => tier.eventId === eventId && tier.questId === soloQuestId)
        .sort((left, right) => left.clearTimeSeconds - right.clearTimeSeconds)
}
