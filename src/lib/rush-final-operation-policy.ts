import {
    getServerGameplaySettingsSync,
    type ServerGameplaySettings,
} from "../data/domains/server-settings"
import {
    isRushFinalOperationOverridePurchaseCandidate,
    resolveRushFinalOperationOverride,
    type RushFinalOperationOverride,
} from "./rush-final-operation-override"
import type { ShopCatalog } from "./shop/model"
import type { ShopType } from "./types/shop"

/**
 * Single runtime owner of the Rush final-operation private override.
 * Folder clear rewards, the event shop list and the compatibility
 * purchase period all compose from the one value resolved here, so the
 * override is either fully enabled or fully absent — there is no partial
 * state and no override residue in any content cache.
 */
export function resolveRushFinalOperationOverrideForRuntime(): RushFinalOperationOverride | null {
    return resolveRushFinalOperationOverrideForSettings(getServerGameplaySettingsSync())
}

export function resolveRushFinalOperationOverrideForPurchase(
    catalog: ShopCatalog,
    shopType: ShopType,
    shopItemIds: readonly number[],
): RushFinalOperationOverride | null {
    if (!isRushFinalOperationOverridePurchaseCandidate(catalog, shopType, shopItemIds)) {
        return null
    }
    return resolveRushFinalOperationOverrideForRuntime()
}

export function resolveRushFinalOperationOverrideForSettings(
    settings: Pick<ServerGameplaySettings, "rush700011To700017CompatibilityEnabled">,
): RushFinalOperationOverride | null {
    return resolveRushFinalOperationOverride(
        settings.rush700011To700017CompatibilityEnabled,
    )
}
