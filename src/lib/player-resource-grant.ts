import { getDb } from "../data/db"

export type PlayerGrantResource = "freeMana" | "freeVmoney" | "expPool"

export interface PlayerResourceGrantState {
    readonly playerId: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface MutablePlayerResourceGrantState {
    readonly playerId: number
    freeMana: number
    freeVmoney: number
    expPool: number
}

export interface PlayerResourceGrantDelta {
    readonly resource: PlayerGrantResource
    readonly requestedAmount: number
    readonly beforeAmount: number
    readonly afterAmount: number
}

export class PlayerResourceGrantError extends Error {
    readonly field: PlayerGrantResource | "playerId" | "totalManaObtained"

    constructor(field: PlayerResourceGrantError["field"], message?: string) {
        super(message ?? `Invalid Player resource grant: ${field}`)
        this.name = "PlayerResourceGrantError"
        this.field = field
    }
}

function positivePlayerId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new PlayerResourceGrantError("playerId")
    }
    return value
}

function amount(value: unknown, field: PlayerGrantResource): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new PlayerResourceGrantError(field)
    }
    return value
}

export function createPlayerResourceGrantState(
    value: PlayerResourceGrantState,
): MutablePlayerResourceGrantState {
    return {
        playerId: positivePlayerId(value.playerId),
        freeMana: amount(value.freeMana, "freeMana"),
        freeVmoney: amount(value.freeVmoney, "freeVmoney"),
        expPool: amount(value.expPool, "expPool"),
    }
}

export function grantPlayerResource(
    state: MutablePlayerResourceGrantState,
    resource: PlayerGrantResource,
    requestedAmount: number,
): PlayerResourceGrantDelta {
    const requested = amount(requestedAmount, resource)
    if (requested === 0) throw new PlayerResourceGrantError(resource)
    const beforeAmount = state[resource]
    const afterAmount = beforeAmount + requested
    if (!Number.isSafeInteger(afterAmount)) throw new PlayerResourceGrantError(resource)
    state[resource] = afterAmount
    return Object.freeze({ resource, requestedAmount: requested, beforeAmount, afterAmount })
}

export function snapshotPlayerResourceGrantState(
    state: PlayerResourceGrantState,
): PlayerResourceGrantState {
    return Object.freeze({ ...createPlayerResourceGrantState(state) })
}

export function persistPlayerResourceGrantsWithinTransactionSync(
    before: PlayerResourceGrantState,
    after: PlayerResourceGrantState,
): void {
    if (!getDb().inTransaction) {
        throw new PlayerResourceGrantError("playerId", "Player resource grant requires a transaction")
    }
    const normalizedBefore = createPlayerResourceGrantState(before)
    const normalizedAfter = createPlayerResourceGrantState(after)
    if (normalizedBefore.playerId !== normalizedAfter.playerId) {
        throw new PlayerResourceGrantError("playerId")
    }
    const manaDelta = normalizedAfter.freeMana - normalizedBefore.freeMana
    if (!Number.isSafeInteger(manaDelta) || manaDelta < 0
        || normalizedAfter.freeVmoney < normalizedBefore.freeVmoney
        || normalizedAfter.expPool < normalizedBefore.expPool) {
        throw new PlayerResourceGrantError("freeMana")
    }
    if (manaDelta === 0
        && normalizedAfter.freeVmoney === normalizedBefore.freeVmoney
        && normalizedAfter.expPool === normalizedBefore.expPool) return

    const vmoneyDelta = normalizedAfter.freeVmoney - normalizedBefore.freeVmoney
    const expPoolDelta = normalizedAfter.expPool - normalizedBefore.expPool
    // 追加式（delta）持久化：同事务的结算钩子（角色/装备获得、玛纳任务）
    // 会在调用方读取快照之后合法写入资源，绝对值 + before 相等 CAS 会把
    // 协调写入误判为写冲突并回滚整单（2026-10-10：礼包兑换/邮件领取 500）。
    // 写事务内不存在并发写者，delta 叠合即正确语义；守卫保留行存在性
    // （changes=1）、结果非负与安全整数上界。
    const result = getDb().prepare(`
        UPDATE players
        SET free_vmoney = free_vmoney + ?, free_mana = free_mana + ?,
            exp_pool = exp_pool + ?,
            total_mana_obtained = total_mana_obtained + ?
        WHERE id = ?
          AND free_vmoney + ? >= 0
          AND free_vmoney + ? <= ?
          AND free_mana + ? >= 0
          AND free_mana + ? <= ?
          AND exp_pool + ? >= 0
          AND exp_pool + ? <= ?
          AND typeof(total_mana_obtained) = 'integer'
          AND total_mana_obtained >= 0
          AND total_mana_obtained <= ? - ?
    `).run(
        vmoneyDelta,
        manaDelta,
        expPoolDelta,
        manaDelta,
        normalizedAfter.playerId,
        vmoneyDelta,
        vmoneyDelta,
        Number.MAX_SAFE_INTEGER,
        manaDelta,
        manaDelta,
        Number.MAX_SAFE_INTEGER,
        expPoolDelta,
        expPoolDelta,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        manaDelta,
    )
    if (result.changes !== 1) {
        throw new PlayerResourceGrantError(
            "totalManaObtained",
            "Player resource grant did not update one valid Player row",
        )
    }
    // 玛纳入账是「累计获得玛纳」事实（任务 40 族）的产生时点：当场窄域结算。
    // 惰性要求（lazy require）：mission/settlement 依赖树可能回指本模块。
    // 通用入账点一次覆盖邮件附件/嘉年华/登录奖励等全部通用发放源。
    if (manaDelta > 0) {
        const { settleManaAdditionMissions } = require("./mana-addition-mission-settlement") as typeof import("./mana-addition-mission-settlement")
        const { getServerDate } = require("../utils") as typeof import("../utils")
        settleManaAdditionMissions(normalizedAfter.playerId, getServerDate())
    }
}
