import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import {
    addMissionCounterSync,
    getMissionCounterValueSync,
    MissionCounterQuery,
} from "./mission-counters"

export { getMissionCounterValueSync }

interface RescueMissionRow {
    missionId: number
    category: 1 | 2 | 3
    rangeKind: 2 | 5
    rank: number | null
    eventId: number | null
}

let cachedRows: readonly RescueMissionRow[] | null = null

/** cat1/cat2/cat3 全部 patternType 20 救援任务行（显式选择子：rank 或 eventId）。 */
function rescueMissionRows(): readonly RescueMissionRow[] {
    if (cachedRows) return cachedRows
    const rows: RescueMissionRow[] = []
    const scan = (category: 1 | 2 | 3, kindCol: number, table: string) => {
        const raw = require(`../../../assets/${table}`) as Record<string, unknown[][]>
        for (const [missionId, variants] of Object.entries(raw)) {
            for (const row of variants) {
                const kind = String(row[kindCol])
                const id = Number(missionId)
                if (!Number.isSafeInteger(id)) continue
                if (String(row[2]) !== "20") continue
                if (kind === "2" && String(row[11]) !== "(None)" && String(row[11]) !== "") {
                    rows.push({ missionId: id, category, rangeKind: 2, rank: Number(row[11]), eventId: null })
                } else if (kind === "5" && String(row[8]) !== "") {
                    rows.push({ missionId: id, category, rangeKind: 5, rank: null, eventId: Number(row[8]) })
                }
            }
        }
    }
    scan(1, 7, "mission_regular.json")
    scan(2, 7, "mission_daily.json")
    scan(3, 7, "mission_event.json")
    cachedRows = rows
    return rows
}

export const RESCUE_CLEAR_DIMENSION = "battle.multi_rescue_clear"
export const NEWBIE_RESCUE_CLEAR_DIMENSION = "battle.multi_newbie_rescue_clear"
const LIFETIME = "lifetime" as const
const ALL = "all" as const

export function rescueClearQuery(questRank?: number): MissionCounterQuery {
    return {
        dimension: RESCUE_CLEAR_DIMENSION,
        scopeType: LIFETIME,
        scopeKey: ALL,
        ...(questRank === undefined ? {} : { qualifier: { questRank } }),
    }
}

export function newbieRescueClearQuery(): MissionCounterQuery {
    return { dimension: NEWBIE_RESCUE_CLEAR_DIMENSION, scopeType: LIFETIME, scopeKey: ALL }
}

/**
 * 救援战斗计数累加（多人 finish 总事务内调用）：
 * - rescue：不限档总量一条（cond20/称号「累计完成救援」）；
 * - 领主战（cat2）追加按难度档的 questRank 限定计数（常驻 rank1-4 任务）；
 * - newbieRescue：新手房主管线独立维度（cond92）。
 * questRank 取领主战 id 末位（= 原始表 stage 索引列，1-5 档）。
 */
export function recordRescueBattleMissionCountersSync(
    playerId: number,
    input: {
        rescue: boolean
        newbieRescue: boolean
        questCategory: number
        questId: number
    },
): void {
    if (input.rescue) {
        addMissionCounterSync(playerId, rescueClearQuery())
        if (input.questCategory === 2) {
            const questRank = Math.abs(Math.trunc(input.questId)) % 10
            if (questRank >= 1 && questRank <= 5) {
                addMissionCounterSync(playerId, rescueClearQuery(questRank))
            }
        }
    }
    if (input.newbieRescue) {
        addMissionCounterSync(playerId, newbieRescueClearQuery())
    }
    if (!input.rescue && !input.newbieRescue) return

    // 直接递增匹配的救援任务行（cat1/cat2/cat3 persisted 生产者）：
    // 领主战 rank 档（id 末位）与降临 eventId（questId 前 4 位=floor(id/1000)）。
    const rank = Math.abs(Math.trunc(input.questId)) % 10
    const adventEventId = Math.floor(Math.trunc(input.questId) / 1000)
    for (const row of rescueMissionRows()) {
        const matched = row.rangeKind === 2
            ? (input.questCategory === 2 && row.rank !== null && row.rank === rank)
            : ((input.questCategory === 7 || input.questCategory === 8)
                && row.eventId !== null && row.eventId === adventEventId)
        if (!matched) continue
        incrementPlayerCategoryMissionSync(playerId, row.category, row.missionId, 1)
    }
}
