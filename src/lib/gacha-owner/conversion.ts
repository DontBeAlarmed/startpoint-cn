import { deepFreeze } from "../../content/deep-freeze"
import { getDb } from "../../data/db"
import {
    getPendingPlayerGachaConversionsSync,
    markPlayerGachaConversionShownSync,
    recordPlayerGachaConversionSync,
} from "../../data/domains/gacha-lifecycle-state"
import { getPlayerGachaInfoListSync, updatePlayerGachaInfoSync } from "../../data/domains/gacha"
import { getPlayerSync } from "../../data/domains/player"
import type { Player } from "../../data/types"
import { createRewardGrantItemOverflowPolicy } from "../reward-grant-item-overflow"
import { settleDirectItemOverflowsWithinTransactionSync } from "../item-overflow"
import { STACK_CONVERSION_REWARD_ITEM_ID } from "../character-growth/limits"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { getGachaCatalog } from "../gacha-catalog"
import { getGachaExtensionTicketIds, hasRemainingGachaPathSync } from "./availability"

export interface GachaPointConversionEntry {
    readonly gachaId: number
    readonly requestedPoint: number
    readonly starGrainAfter: number
    readonly overflowStarGrain: number
}

export type GachaPointConversionSettlement = Readonly<{
    status: "none" | "converted"
    entries: readonly GachaPointConversionEntry[]
    /** 转换后的星之粒(990008)持有数;none 时为 null。 */
    starGrainAfter: number | null
}>

export function settleExpiredGachaPointsOnLoadSync(input: {
    readonly playerId: number
    readonly nowMs: number
    /** Current player row when the caller already holds it (same synchronous request). */
    readonly player?: Player
}): GachaPointConversionSettlement {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
        throw new TypeError("Gacha conversion input is invalid")
    }
    return getDb().transaction(() => {
        const player = input.player ?? getPlayerSync(input.playerId)
        if (player === null) throw new Error("Gacha conversion player disappeared")
        const infos = getPlayerGachaInfoListSync(input.playerId).filter(info => (
            Number.isSafeInteger(info.gachaExchangePoint) && (info.gachaExchangePoint ?? 0) > 0
        ))
        if (infos.length === 0) return deepFreeze({
            status: "none" as const,
            entries: [],
            starGrainAfter: null,
        })
        const catalog = getGachaCatalog()
        return withDeferredInventoryBatchContextWithinTransactionSync({
            playerId: input.playerId,
            playerExistence: "caller-verified",
        }, inventory => {
            const ticketIds = [...new Set(infos.flatMap(info => {
                const banner = catalog.banners[String(info.gachaId)]
                return banner === undefined ? [] : getGachaExtensionTicketIds(banner)
            }))]
            inventory.readMany([...ticketIds, STACK_CONVERSION_REWARD_ITEM_ID])
            const overflowPolicy = createRewardGrantItemOverflowPolicy(input.playerId)
            let starGrainAfter: number | null = null
            const entries: GachaPointConversionEntry[] = []
            for (const info of infos) {
                const banner = catalog.banners[String(info.gachaId)]
                // banner 不在当前 Content 与 Comeback/Stars 缺 player period 同样
                // 表示"无法证明仍存在合法 draw/exchange 路径"：draw/exchange 都已
                // fail closed，点数不可能再被消费，按不丢资产政策执行转换。
                if (banner !== undefined && hasRemainingGachaPathSync({
                    playerId: input.playerId,
                    banner,
                    nowMs: input.nowMs,
                    getTicketCount: itemId => inventory.read(itemId).afterAmount,
                })) continue
                const requestedPoint = info.gachaExchangePoint as number
                // 官方语义(客户端 HomeScene converted_exchange_point_dialog):
                // 剩余兑换点 1:1 转为星之粒道具 990008 入包——不再计入
                // star_crumb(星之碎片)余额,那是另一货币(付费石 75:1 累计)。
                const grant = inventory.grantWithCapacity(
                    STACK_CONVERSION_REWARD_ITEM_ID,
                    requestedPoint,
                    overflowPolicy.maxCount(STACK_CONVERSION_REWARD_ITEM_ID),
                )
                const overflowStarGrain = grant.overflowAmount
                const overflowSettlement = overflowStarGrain > 0
                    ? settleDirectItemOverflowsWithinTransactionSync({
                        playerId: input.playerId,
                        overflows: [{ itemId: STACK_CONVERSION_REWARD_ITEM_ID, amount: overflowStarGrain }],
                    })
                    : null
                updatePlayerGachaInfoSync(input.playerId, {
                    gachaId: info.gachaId,
                    gachaExchangePoint: 0,
                })
                recordPlayerGachaConversionSync({
                    playerId: input.playerId,
                    gachaId: info.gachaId,
                    point: requestedPoint,
                    convertedAt: Math.floor(input.nowMs / 1000),
                })
                starGrainAfter = grant.afterAmount
                entries.push({
                    gachaId: info.gachaId,
                    requestedPoint,
                    starGrainAfter: grant.afterAmount,
                    overflowStarGrain,
                })
                void overflowSettlement
            }
            inventory.flush() // deferred 批次:入包增量在返回前落库(load 序列化要读到)
            return deepFreeze({
                status: entries.length === 0 ? "none" as const : "converted" as const,
                entries,
                starGrainAfter,
            })
        })
    })()
}

export function projectPendingGachaConversionsSync(playerId: number): readonly Readonly<{
    gacha_id: number
    gacha_exchange_point: number
}>[] {
    return getPendingPlayerGachaConversionsSync(playerId).map(conversion => ({
        gacha_id: conversion.gachaId,
        gacha_exchange_point: conversion.pendingPoint,
    }))
}

export function acknowledgeGachaConversionShownSync(playerId: number, gachaId: number): void {
    markPlayerGachaConversionShownSync(playerId, gachaId)
}
