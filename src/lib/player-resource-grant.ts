import { getDb } from "../data/db"
import type { MissionSettlementResult } from "./mission/settlement"

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
): MissionSettlementResult | null {
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
        && normalizedAfter.expPool === normalizedBefore.expPool) return null

    const vmoneyDelta = normalizedAfter.freeVmoney - normalizedBefore.freeVmoney
    const expPoolDelta = normalizedAfter.expPool - normalizedBefore.expPool
    // R-G01：玛纳入账走总额容量口径（free+paid ≤ maxMana，与 item-sell/
    // event-trade/single-finish 同政）。在 persist 单点收口——所有生产者
    // （礼包码/邮件附件/嘉年华/登录奖励/扭蛋箱/任务直发/引擎通用发放）都经
    // 此落库。引擎的 known-state 不携带 paidMana，且 paidMana 在单次授予内
    // 不可变，故以 persist 时刻的同事务权威行为准；越顶部分转 FREE_MANA
    // 溢出邮件（维护者裁决），totalManaObtained 只计 accepted。
    let acceptedManaDelta = manaDelta
    // 仅玛纳入账路径收紧 CAS 上界；无玛纳 persist（存量已越顶钱包的
    // vmoney/exp 发放）不得被游戏上限连带卡死，走原 MAX_SAFE_INTEGER 语义
    let manaCasBound = Number.MAX_SAFE_INTEGER
    if (manaDelta > 0) {
        const { planManaCapacity } = require("./inventory/mana-capacity-plan") as typeof import("./inventory/mana-capacity-plan")
        const { getCurrencyCapacityPolicySync } = require("./config-content") as typeof import("./config-content")
        const wallet = getDb().prepare(
            "SELECT free_mana, paid_mana FROM players WHERE id = ?"
        ).get(normalizedAfter.playerId) as { free_mana: number; paid_mana: number } | undefined
        if (wallet === undefined) {
            throw new PlayerResourceGrantError("playerId")
        }
        const capacity = planManaCapacity({
            freeMana: wallet.free_mana,
            paidMana: wallet.paid_mana,
            maxMana: getCurrencyCapacityPolicySync().maxMana,
            requestedMana: manaDelta,
        })
        acceptedManaDelta = capacity.acceptedMana
        manaCasBound = getCurrencyCapacityPolicySync().maxMana
        if (capacity.overflowMana > 0) {
            const { insertManaOverflowMailsWithinTransactionSync } = require("./mail-overflow") as typeof import("./mail-overflow")
            const maxAttachmentNumber = Math.max(
                1,
                Math.min(getCurrencyCapacityPolicySync().maxMana, 2_147_483_647),
            )
            insertManaOverflowMailsWithinTransactionSync(
                normalizedAfter.playerId,
                capacity.overflowMana,
                maxAttachmentNumber,
            )
        }
    }
    // 追加式（delta）持久化：同事务的结算钩子（角色/装备获得、玛纳任务）
    // 会在调用方读取快照之后合法写入资源，绝对值 + before 相等 CAS 会把
    // 协调写入误判为写冲突并回滚整单（2026-10-10：礼包兑换/邮件领取 500）。
    // 写事务内不存在并发写者，delta 叠合即正确语义；守卫保留行存在性
    // （changes=1）、结果非负与安全整数上界。
    // manaCasBound：玛纳路径=游戏上限（含 paid_mana 侧写），无玛纳路径=原上界。
    // 正常路径 acceptedManaDelta 已在 JS 侧按容量拆分，CAS 兜底同事务内结算
    // 钩子晚写的极端组合，违例即整单回滚（fail-closed）
    const result = getDb().prepare(`
        UPDATE players
        SET free_vmoney = free_vmoney + ?, free_mana = free_mana + ?,
            exp_pool = exp_pool + ?,
            total_mana_obtained = total_mana_obtained + ?
        WHERE id = ?
          AND free_vmoney + ? >= 0
          AND free_vmoney + ? <= ?
          AND free_mana + ? >= 0
          AND free_mana + ? + paid_mana <= ?
          AND exp_pool + ? >= 0
          AND exp_pool + ? <= ?
          AND typeof(total_mana_obtained) = 'integer'
          AND total_mana_obtained >= 0
          AND total_mana_obtained <= ? - ?
    `).run(
        vmoneyDelta,
        acceptedManaDelta,
        expPoolDelta,
        acceptedManaDelta,
        normalizedAfter.playerId,
        vmoneyDelta,
        vmoneyDelta,
        Number.MAX_SAFE_INTEGER,
        acceptedManaDelta,
        acceptedManaDelta,
        manaCasBound,
        expPoolDelta,
        expPoolDelta,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        acceptedManaDelta,
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
    if (acceptedManaDelta > 0) {
        const { settleManaAdditionMissions } = require("./mana-addition-mission-settlement") as typeof import("./mana-addition-mission-settlement")
        const { getServerDate } = require("../utils") as typeof import("../utils")
        // R-07：返回结算结果供调用方投影（原为丢弃）
        return settleManaAdditionMissions(normalizedAfter.playerId, getServerDate())
    }
    return null
}
