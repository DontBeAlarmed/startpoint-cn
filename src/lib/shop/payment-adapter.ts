import { updatePlayerSync } from "../../data/domains/player"
import type { ShopPurchasePlayerState } from "./purchase-plan"

export interface ShopPaymentPlayer extends ShopPurchasePlayerState {
    readonly id: number
}

export function persistShopPaymentWithinTransactionSync(
    playerBefore: ShopPaymentPlayer,
    playerAfter: ShopPurchasePlayerState,
): ShopPaymentPlayer {
    const changed = playerBefore.vmoney !== playerAfter.vmoney
        || playerBefore.freeVmoney !== playerAfter.freeVmoney
        || playerBefore.paidMana !== playerAfter.paidMana
        || playerBefore.freeMana !== playerAfter.freeMana
        || playerBefore.bondToken !== playerAfter.bondToken
        || playerBefore.expPool !== playerAfter.expPool
    if (changed) {
        updatePlayerSync({ id: playerBefore.id, ...playerAfter })
    }
    return { id: playerBefore.id, ...playerAfter }
}
