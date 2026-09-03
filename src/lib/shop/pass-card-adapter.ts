import { addPlayerPassCardPointSync } from "../../data/domains/pass-card"
import { getActivePassCardEventDefinitionAt } from "../pass-card"
import type { ShopPurchaseEffect } from "./purchase-plan"
import { ShopPurchasePlanError } from "./purchase-validation"

export interface PreparedShopPassCardEffect {
    readonly shopItemId: number
    readonly eventId: number
    readonly points: number
    readonly thresholdPoint: number
}

export interface AppliedShopPassCardEffect {
    readonly shopItemId: number
    readonly eventId: number
    readonly pointAfter: number
}

export function prepareShopPassCardEffect(
    effect: Extract<ShopPurchaseEffect, { kind: "passCardPoint" }>,
    virtualNow: Date,
): PreparedShopPassCardEffect {
    const event = getActivePassCardEventDefinitionAt(virtualNow)
    if (event === undefined) throw new ShopPurchasePlanError("No active pass card.")
    return {
        shopItemId: effect.shopItemId,
        eventId: event.eventId,
        points: effect.points,
        thresholdPoint: event.thresholdPoint,
    }
}

export function applyPreparedShopPassCardEffectWithinTransactionSync(
    playerId: number,
    prepared: PreparedShopPassCardEffect,
): AppliedShopPassCardEffect {
    return {
        shopItemId: prepared.shopItemId,
        eventId: prepared.eventId,
        pointAfter: addPlayerPassCardPointSync(
            playerId,
            prepared.eventId,
            prepared.points,
            prepared.thresholdPoint,
        ),
    }
}
