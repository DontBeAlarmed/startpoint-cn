import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import { QuestCategory } from "./types"

// R-G04：领主战参加门。boss_battle_join_gates.json 由转换器从
// boss_battle_quest 的 viewable_need_quest_1/2 列派生（buildBossBattleJoinGates），
// 记录每个 boss 任务的选择前置（主线关卡进度 / 前一档通关）。多人加入路径
// 在 select/prepare/create/start 前校验加入者的任务进度，未满足即软拒——
// 堵住"通过房间号加入未解锁档位跳关"的缺口（2026-10-25 维护者裁决）。

export interface BossJoinGateReference {
    readonly category: number
    readonly questId: number
}

export type BossJoinGateTable = Readonly<Record<string, readonly BossJoinGateReference[]>>

export function validateBossJoinGateTable(value: unknown): BossJoinGateTable {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("invalid boss_battle_join_gates content: root must be an object")
    }
    const output: Record<string, readonly BossJoinGateReference[]> = {}
    for (const [questId, references] of Object.entries(value)) {
        if (!/^[1-9]\d*$/.test(questId) || !Array.isArray(references)) {
            throw new TypeError(`invalid boss_battle_join_gates content: malformed entry ${questId}`)
        }
        const parsed = references.map(reference => {
            if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
                throw new TypeError(`invalid boss_battle_join_gates content: malformed reference in ${questId}`)
            }
            const category = (reference as Record<string, unknown>).category
            const refQuestId = (reference as Record<string, unknown>).questId
            if (typeof category !== "number" || !Number.isSafeInteger(category) || category <= 0
                || typeof refQuestId !== "number" || !Number.isSafeInteger(refQuestId) || refQuestId <= 0) {
                throw new TypeError(`invalid boss_battle_join_gates content: malformed reference in ${questId}`)
            }
            return { category, questId: refQuestId }
        })
        output[questId] = Object.freeze(parsed)
    }
    return Object.freeze(output)
}

const gateTables = new WeakMap<ReadonlyContentRepository, BossJoinGateTable>()

function getBossJoinGateTable(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): BossJoinGateTable {
    const cached = gateTables.get(repository)
    if (cached !== undefined) return cached
    const table = validateBossJoinGateTable(repository.table("boss_battle_join_gates.json"))
    gateTables.set(repository, table)
    return table
}

/**
 * 该任务是否属于领主战（category 2）且配有参加门。非 boss 任务恒无门。
 */
export function hasBossJoinGate(
    category: number,
    questId: number,
    repository?: ReadonlyContentRepository,
): boolean {
    // category 短路必须先于内容快照解析（默认参数在函数体前求值，
    // 无内容快照的测试环境会被误伤）
    if (category !== QuestCategory.BOSS_BATTLE) return false
    return getBossJoinGateTable(repository)[String(questId)] !== undefined
}

export interface BossJoinGateProgressReader {
    readonly finished: boolean
}

/**
 * 加入者是否满足领主战参加门：所有前置引用（主线关卡/前一档）均已通关。
 * 门数据缺失（无门 boss）恒放行；进度读取由调用方注入（多人 HTTP 上下文
 * 持有 player 读取面，避免本模块反向依赖 data 层）。
 */
export function isBossQuestJoinAllowed(
    category: number,
    questId: number,
    readProgress: (refCategory: number, refQuestId: number) => BossJoinGateProgressReader | null,
    repository?: ReadonlyContentRepository,
): boolean {
    // 同 hasBossJoinGate：category 短路先于快照解析
    if (category !== QuestCategory.BOSS_BATTLE) return true
    const references = getBossJoinGateTable(repository)[String(questId)]
    if (references === undefined) return true
    for (const reference of references) {
        const progress = readProgress(reference.category, reference.questId)
        if (progress?.finished !== true) return false
    }
    return true
}
