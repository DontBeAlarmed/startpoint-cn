import { getServerGameplaySettingsSync } from "../data/domains/server-settings"
import {
    resolveRushFinalOperationOverride,
    type RushFinalOperationOverride,
} from "./shop/rush-final-operation-override"

/**
 * Single runtime owner of the Rush final-operation private override.
 * Folder clear rewards, the event shop list and the compatibility
 * purchase period all compose from the one value resolved here, so the
 * override is either fully enabled or fully absent — there is no partial
 * state and no override residue in any content cache.
 */
export function resolveRushFinalOperationOverrideForRuntime(): RushFinalOperationOverride | null {
    return resolveRushFinalOperationOverride(
        getServerGameplaySettingsSync().rush700011To700017CompatibilityEnabled,
    )
}
