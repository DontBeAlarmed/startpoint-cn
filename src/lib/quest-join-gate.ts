import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import { QuestCategory } from "./types"

// R-G04：任务参加门（泛化版）。quest_join_gates.json 由转换器从 20 张任务表
// 的 viewable_need_quest_1/2 列派生（buildQuestJoinGates，列位经各表 Values
// 构造器锚定），记录每个任务的选择前置（主线进度/前一档/剧情集数）。
// 多人加入路径在 select/prepare/create/start 前校验加入者的任务进度，
// 未满足即软拒——堵住"通过房间号加入未解锁档位跳关"的缺口
//（2026-10-25 维护者裁决；2026-10-26 实测风神雷神（降临族）未拦后泛化）。

export interface BossJoinGateReference {
    readonly category: number
    readonly questId: number
}

export type BossJoinGateSection = Readonly<Record<string, readonly BossJoinGateReference[]>>
export type BossJoinGateTable = Readonly<Record<string, BossJoinGateSection>>

export function validateQuestJoinGateTable(value: unknown): BossJoinGateTable {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("invalid quest_join_gates content: root must be an object")
    }
    const output: Record<string, BossJoinGateSection> = {}
    for (const [tableName, section] of Object.entries(value)) {
        if (section === null || typeof section !== "object" || Array.isArray(section)) {
            throw new TypeError(`invalid quest_join_gates content: malformed table section ${tableName}`)
        }
        const gates: Record<string, readonly BossJoinGateReference[]> = {}
        for (const [questId, references] of Object.entries(section)) {
            if (!/^[1-9]\d*$/.test(questId) || !Array.isArray(references)) {
                throw new TypeError(`invalid quest_join_gates content: malformed entry ${tableName}/${questId}`)
            }
            const parsed = references.map(reference => {
                if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
                    throw new TypeError(`invalid quest_join_gates content: malformed reference in ${tableName}/${questId}`)
                }
                const category = (reference as Record<string, unknown>).category
                const refQuestId = (reference as Record<string, unknown>).questId
                if (typeof category !== "number" || !Number.isSafeInteger(category) || category <= 0
                    || typeof refQuestId !== "number" || !Number.isSafeInteger(refQuestId) || refQuestId <= 0) {
                    throw new TypeError(`invalid quest_join_gates content: malformed reference in ${tableName}/${questId}`)
                }
                return { category, questId: refQuestId }
            })
            gates[questId] = Object.freeze(parsed)
        }
        output[tableName] = Object.freeze(gates)
    }
    return Object.freeze(output)
}

const gateTables = new WeakMap<ReadonlyContentRepository, BossJoinGateTable>()

function getQuestJoinGateTable(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): BossJoinGateTable {
    const cached = gateTables.get(repository)
    if (cached !== undefined) return cached
    const table = validateQuestJoinGateTable(repository.table("quest_join_gates.json"))
    gateTables.set(repository, table)
    return table
}

/** 门查找的 fail-open 包装：内容快照未初始化（如无内容环境的注入测试）时不
 * 阻塞加入。表损坏/校验失败不属于"快照不可用"——大声抛出，不静默放行。 */
function tryGetQuestJoinGateSection(
    category: number,
    repository?: ReadonlyContentRepository,
): BossJoinGateSection | null {
    const section = GATE_SECTION_BY_CATEGORY[category]
    if (section === undefined) return null
    let resolved: ReadonlyContentRepository
    try {
        resolved = repository ?? getContentSnapshot().repository
    } catch {
        // 仅快照未初始化走 fail-open（ContentSnapshotError/其它初始化错误）
        return null
    }
    return getQuestJoinGateTable(resolved)[section] ?? null
}

// 房间 category → 门表分节。single/multi 变体（如降临 7/8）共用同一张任务表。
const GATE_SECTION_BY_CATEGORY: Readonly<Record<number, string>> = Object.freeze({
    1: "main_quest", 2: "boss_battle_quest", 3: "character_quest", 4: "ex_quest",
    6: "daily_week_event_quest", 7: "advent_event_quest", 8: "advent_event_quest",
    10: "story_event_single_quest", 11: "ranking_event_single_quest",
    13: "challenge_dungeon_event_quest", 14: "daily_exp_mana_event_quest",
    18: "world_story_event_quest", 19: "world_story_event_boss_battle_quest",
    20: "tower_dungeon_event_quest", 21: "expert_single_event_quest",
    22: "carnival_event_quest", 23: "raid_event_quest", 24: "rush_event_quest",
    25: "solo_time_attack_event_quest", 26: "hard_multi_event_quest",
    27: "score_attack_event_quest", 15: "practice_quest",
})

/**
 * 该任务是否属于领主战（category 2）且配有参加门。非 boss 任务恒无门。
 */
export function hasQuestJoinGate(
    category: number,
    questId: number,
    repository?: ReadonlyContentRepository,
): boolean {
    // category 短路必须先于内容快照解析（默认参数在函数体前求值，
    // 无内容快照的测试环境会被误伤）
    const section = tryGetQuestJoinGateSection(category, repository)
    if (section === null) return false
    return section[String(questId)] !== undefined
}

export interface BossJoinGateProgressReader {
    readonly finished: boolean
}

/**
 * 加入者是否满足领主战参加门：所有前置引用（主线关卡/前一档）均已通关。
 * 门数据缺失（无门 boss）恒放行；进度读取由调用方注入（多人 HTTP 上下文
 * 持有 player 读取面，避免本模块反向依赖 data 层）。
 */
export function isQuestJoinAllowed(
    category: number,
    questId: number,
    readProgress: (refCategory: number, refQuestId: number) => BossJoinGateProgressReader | null,
    repository?: ReadonlyContentRepository,
): boolean {
    // 同 hasQuestJoinGate：category 短路先于快照解析
    const section = tryGetQuestJoinGateSection(category, repository)
    if (section === null) return true
    const references = section[String(questId)]
    if (references === undefined) return true
    for (const reference of references) {
        const progress = readProgress(reference.category, reference.questId)
        if (progress?.finished !== true) return false
    }
    return true
}
