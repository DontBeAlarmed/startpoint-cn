import { playerOwnsCharacterSync } from "../../data/domains/character"
import { playerOwnsEquipmentSync } from "../../data/domains/equipment"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import type { InventoryBatchContext } from "../inventory"
import {
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantExecutionResult,
} from "../reward-grant"
import { createRewardGrantItemOverflowPolicy } from "../reward-grant-item-overflow"
import type { PlannedItemOverflowDisposition } from "../item-overflow"
import { RewardType } from "../types/rewards"
import type { StarCrumbExchangeProduct } from "./catalog"
import { resolveStarCrumbExchangeProduct } from "./catalog"

export type StarCrumbExchangeRejection =
    | { readonly ok: false; readonly kind: "badRequest"; readonly message: string }
    | { readonly ok: false; readonly kind: "internal"; readonly message: string }

export interface StarCrumbExchangeSuccess {
    readonly ok: true
    readonly playerId: number
    readonly exchangeId: number
    readonly product: StarCrumbExchangeProduct
    readonly starCrumbAfter: number
    readonly characters: readonly Readonly<Record<string, unknown>>[]
    readonly rewardItems: Readonly<Record<string, number>>
    readonly equipment: readonly Readonly<Record<string, unknown>>[]
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly freeManaAfter: number | null
}

export type StarCrumbExchangeResult =
    | StarCrumbExchangeSuccess
    | StarCrumbExchangeRejection

function badRequest(message: string): StarCrumbExchangeRejection {
    return { ok: false, kind: "badRequest", message }
}

function internal(message: string): StarCrumbExchangeRejection {
    return { ok: false, kind: "internal", message }
}

function executeProductGrantWithinTransaction(
    player: NonNullable<ReturnType<typeof getPlayerSync>>,
    product: StarCrumbExchangeProduct,
): Omit<StarCrumbExchangeSuccess,
    "ok" | "playerId" | "exchangeId" | "product" | "starCrumbAfter"> {
    return withDeferredInventoryBatchContextWithinTransactionSync({
        playerId: player.id,
        playerExistence: "caller-verified",
    }, (inventory: InventoryBatchContext) => {
        const plan = createRewardGrantExecutionPlan([{
            type: product.kind === "character"
                ? RewardType.CHARACTER
                : product.kind === "equipment" ? RewardType.EQUIPMENT : RewardType.ITEM,
            id: product.targetId,
            count: 1,
        }])
        const grant: RewardGrantExecutionResult = (
            withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                player.id,
                plan,
                {
                    playerId: player.id,
                    freeMana: player.freeMana,
                    freeVmoney: player.freeVmoney,
                    expPool: player.expPool,
                },
                inventory,
                execution => {
                    const result = snapshotRewardGrantExecutionResultForPlan(
                        player.id,
                        plan,
                        execution.result,
                    )
                    execution.finalize()
                    return result
                },
                { itemOverflow: createRewardGrantItemOverflowPolicy(player.id) },
            )
        )
        const rewardItems: Record<string, number> = {}
        for (const entry of grant.entries) {
            if (entry.outcome.kind === "item") {
                rewardItems[String(entry.outcome.item.itemId)] = entry.outcome.item.afterAmount
            }
        }
        const freeManaAfter = grant.playerAfter.freeMana === player.freeMana
            && collectRewardGrantItemOverflowDispositions(grant).every(
                disposition => disposition.kind !== "sold",
            )
            ? null
            : grant.playerAfter.freeMana
        return {
            characters: grant.assets.characters.map(character => character.after),
            rewardItems,
            equipment: grant.assets.equipment.map(equipment => equipment.after),
            itemOverflowDispositions: collectRewardGrantItemOverflowDispositions(grant),
            freeManaAfter,
        }
    })
}

export function executeStarCrumbExchangeSync(input: {
    readonly playerId: number
    readonly exchangeId: number
}): StarCrumbExchangeResult {
    const resolution = resolveStarCrumbExchangeProduct(input.exchangeId)
    if (!resolution.ok) {
        if (resolution.kind === "notFound") {
            return badRequest(
                `Exchange item with id ${input.exchangeId} does not exist.`,
            )
        }
        if (resolution.kind === "noCost") {
            return internal(`No cost data for kind ${resolution.rawKind}.`)
        }
        return internal(
            `Invalid cost for kind=${resolution.rawKind} rarity=${resolution.rarity}.`,
        )
    }
    const product = resolution.product
    console.log(`[exchange:star_crumb] player=${input.playerId} exch=${product.exchangeId}`
        + ` kind=${product.kind === "character" ? 0 : product.kind === "item" ? 1 : 2}`
        + ` id=${product.targetId} rarity=${product.rarity} cost=${product.cost}`)

    const granted = getDb().transaction((): StarCrumbExchangeResult => {
        const player = getPlayerSync(input.playerId)
        if (player === null) return internal("No players bound to account.")
        if (player.starCrumb < product.cost) {
            return badRequest("Not enough star_crumb.")
        }
        if (product.kind === "character"
            && playerOwnsCharacterSync(input.playerId, product.targetId)) {
            return badRequest("Character already owned.")
        }
        if (product.kind === "equipment"
            && playerOwnsEquipmentSync(input.playerId, product.targetId)) {
            return badRequest("Equipment already owned.")
        }
        const starCrumbAfter = player.starCrumb - product.cost
        updatePlayerSync({ id: input.playerId, starCrumb: starCrumbAfter })
        return {
            ok: true,
            playerId: input.playerId,
            exchangeId: product.exchangeId,
            product,
            starCrumbAfter,
            ...executeProductGrantWithinTransaction(player, product),
        }
    })()
    return granted
}
