import { deepFreeze } from "../../content/deep-freeze"
import { getDb } from "../../data/db"
import {
    getPendingPlayerGachaConversionsSync,
    markPlayerGachaConversionShownSync,
    recordPlayerGachaConversionSync,
} from "../../data/domains/gacha-lifecycle-state"
import { getPlayerGachaInfoListSync, updatePlayerGachaInfoSync } from "../../data/domains/gacha"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import type { Player } from "../../data/types"
import { insertStarCrumbOverflowMailWithinTransactionSync } from "../mail-overflow"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { getGachaCatalog } from "../gacha-catalog"
import { getGachaExtensionTicketIds, hasRemainingGachaPathSync } from "./availability"

export interface GachaPointConversionEntry {
    readonly gachaId: number
    readonly requestedPoint: number
    readonly acceptedStarCrumb: number
    readonly starCrumbAfter: number
    readonly overflowStarCrumb: number
    readonly overflowMailId: number | null
}

export type GachaPointConversionSettlement = Readonly<{
    status: "none" | "converted"
    entries: readonly GachaPointConversionEntry[]
    starCrumbAfter: number
}>

export function settleExpiredGachaPointsOnLoadSync(input: {
    readonly playerId: number
    readonly nowMs: number
    readonly maxStarCrumb: number
    /** Current player row when the caller already holds it (same synchronous request). */
    readonly player?: Player
}): GachaPointConversionSettlement {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
        || !Number.isSafeInteger(input.maxStarCrumb) || input.maxStarCrumb < 0) {
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
            starCrumbAfter: player.starCrumb,
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
            inventory.readMany(ticketIds)
            let starCrumbAfter = player.starCrumb
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
                const acceptedStarCrumb = Math.min(
                    requestedPoint,
                    Math.max(0, input.maxStarCrumb - starCrumbAfter),
                )
                const overflowStarCrumb = requestedPoint - acceptedStarCrumb
                starCrumbAfter += acceptedStarCrumb
                const overflowMail = overflowStarCrumb === 0
                    ? null
                    : insertStarCrumbOverflowMailWithinTransactionSync(
                        input.playerId,
                        overflowStarCrumb,
                        new Date(input.nowMs),
                    )
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
                entries.push({
                    gachaId: info.gachaId,
                    requestedPoint,
                    acceptedStarCrumb,
                    starCrumbAfter,
                    overflowStarCrumb,
                    overflowMailId: overflowMail?.mailId ?? null,
                })
            }
            if (entries.length > 0 && starCrumbAfter !== player.starCrumb) {
                updatePlayerSync({ id: input.playerId, starCrumb: starCrumbAfter })
            }
            return deepFreeze({
                status: entries.length === 0 ? "none" as const : "converted" as const,
                entries,
                starCrumbAfter,
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
