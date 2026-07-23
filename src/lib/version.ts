/** Backward-compatible version facade over the process-pinned content snapshot. */
import { getContentSnapshot } from "../content/runtime/content-snapshot";

// CDN full archives are at version 1.4.0
export const FULL_BASE = "1.4.0";

export function getEffectiveVersion(): string {
    return getContentSnapshot().cdn.targetVersion;
}

export function detectCDNVersion(): string {
    return getContentSnapshot().cdn.targetVersion;
}
