/**
 * Unified CN asset version selection.
 *
 * The validated release graph is the single authority for the advertised
 * target and the exact diff path returned to a client.
 */
import {
    compareReleaseVersions,
    findReleasePath,
    getCnReleaseGraphSnapshot,
} from "./cn-asset-graph";
import type { ReleaseGraphSnapshot, ReleasePathResult } from "./cn-asset-graph";


// CDN full archives are at version 1.4.0.
export const FULL_BASE = "1.4.0";

const VERSION_RE = /^\d+\.\d+\.\d+$/;


export interface AssetTarget {
    targetVersion: string;
    isFirstTime: boolean;
    fullVersion: string;
    path: ReleasePathResult;
}


export function parseVersion(version: string): number[] {
    return version.split(".").map(Number);
}


export function compareVersion(left: string, right: string): number {
    return compareReleaseVersions(left, right);
}


export function isFirstTime(resVer?: string, fullBase = FULL_BASE): boolean {
    return !resVer
        || !VERSION_RE.test(resVer)
        || compareReleaseVersions(resVer, fullBase) < 0;
}


export function getEffectiveVersion(
    snapshot: ReleaseGraphSnapshot = getCnReleaseGraphSnapshot(),
): string {
    return snapshot.tailVersion;
}


// Kept as a compatibility alias for scripts that previously called the
// filename-based detector directly.
export function detectCDNVersion(): string {
    return getEffectiveVersion();
}


/**
 * Select the highest reachable target and its exact path from this request's
 * current asset version. A client with no usable version starts at the full
 * archive base. A disconnected or newer client is never downgraded.
 */
export function computeAssetTarget(
    resVer?: string,
    snapshot: ReleaseGraphSnapshot = getCnReleaseGraphSnapshot(),
): AssetTarget {
    const first = isFirstTime(resVer, snapshot.fullBase);
    const startVersion = first ? snapshot.fullBase : resVer!;
    const releasePath = findReleasePath(snapshot, startVersion);
    return {
        targetVersion: releasePath.targetVersion,
        isFirstTime: first,
        fullVersion: startVersion,
        path: releasePath,
    };
}
