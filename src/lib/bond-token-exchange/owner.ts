import { getDb } from "../../data/db"
import {
    listPlayerBondTokenExchangeCountsSync,
    getPlayerBondTokenExchangeCountSync,
    recordPlayerBondTokenExchangeSync,
} from "../../data/domains/bondTokenExchange"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantExecutionResult,
} from "../reward-grant"
import { RewardType } from "../types/rewards"
import {
    listBondTokenExchangeProducts,
    resolveBondTokenExchangeProduct,
    type BondTokenExchangeProduct,
} from "./catalog"

export type BondTokenExchangeRejection =
    | { readonly ok: false; readonly kind: "badRequest"; readonly message: string }
    | { readonly ok: false; readonly kind: "internal"; readonly message: string }

export interface BondTokenExchangeSuccess {
    readonly ok: true
    readonly playerId: number
    readonly product: BondTokenExchangeProduct
    readonly bondTokenAfter: number
    readonly exchangeCount: number
    readonly equipment: readonly Readonly<Record<string, unknown>>[]
}

export type BondTokenExchangeResult =
    | BondTokenExchangeSuccess
    | BondTokenExchangeRejection

export interface BondTokenExchangeListEntry {
    readonly equipmentId: number
    readonly exchangeCount: number
}

function badRequest(message: string): BondTokenExchangeRejection {
    return { ok: false, kind: "badRequest", message }
}

function internal(message: string): BondTokenExchangeRejection {
    return { ok: false, kind: "internal", message }
}

export function listBondTokenExchangeRuntimeSync(
    playerId: number,
    nowMs: number,
): readonly BondTokenExchangeListEntry[] {
    const exchanged = new Map(listPlayerBondTokenExchangeCountsSync(playerId).map(
        entry => [entry.equipmentId, entry.exchangeCount],
    ))
    return listBondTokenExchangeProducts(nowMs).map(product => ({
        equipmentId: product.equipmentId,
        exchangeCount: exchanged.get(product.equipmentId) ?? 0,
    }))
}

export function executeBondTokenExchangeSync(input: {
    readonly playerId: number
    readonly equipmentId: number
    readonly nowMs: number
}): BondTokenExchangeResult {
    const resolution = resolveBondTokenExchangeProduct(input.equipmentId, input.nowMs)
    if (!resolution.ok) {
        if (resolution.kind === "notFound") {
            return badRequest(
                `Bond token exchange product ${input.equipmentId} does not exist.`,
            )
        }
        return badRequest(
            `Bond token exchange product ${input.equipmentId} is outside its available period.`,
        )
    }
    const product = resolution.product

    return getDb().transaction((): BondTokenExchangeResult => {
        const player = getPlayerSync(input.playerId)
        if (player === null) return internal("No players bound to account.")
        const exchangeCount = getPlayerBondTokenExchangeCountSync(
            input.playerId,
            product.equipmentId,
        )
        if (exchangeCount >= product.stock) {
            return badRequest("Bond token exchange is out of stock.")
        }
        if (player.bondToken < product.cost) {
            return badRequest("Not enough bond_token.")
        }
        const bondTokenAfter = player.bondToken - product.cost
        updatePlayerSync({ id: input.playerId, bondToken: bondTokenAfter })
        const nextExchangeCount = recordPlayerBondTokenExchangeSync(
            input.playerId,
            product.equipmentId,
        )
        const grant: RewardGrantExecutionResult = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            input.playerId,
            createRewardGrantExecutionPlan([{
                type: RewardType.EQUIPMENT,
                id: product.equipmentId,
                count: 1,
            }]),
            {
                playerId: input.playerId,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
        )
        console.log(`[exchange:bond_token] player=${input.playerId} equip=${product.equipmentId}`
            + ` cost=${product.cost} stock=${product.stock} count=${nextExchangeCount}`)
        return {
            ok: true,
            playerId: input.playerId,
            product,
            bondTokenAfter,
            exchangeCount: nextExchangeCount,
            equipment: grant.assets.equipment.map(equipment => equipment.after),
        }
    })()
}
