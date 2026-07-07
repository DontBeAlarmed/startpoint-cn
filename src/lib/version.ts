/**
 * Unified version control for CN asset update.
 * 
 * All version-related logic lives here — no hardcoded "1.4.0" "1.4.54"
 * scattered across load.ts / asset.ts.
 */
import { readFileSync, existsSync } from "fs";
import path from "path";

// CN CDN final version — clients below this need full download
export const CDN_BASELINE = "1.4.45";

// Server target version from .env, falls back to CDN baseline
export const SERVER_VERSION = process.env.CN_RES_VERSION || CDN_BASELINE;

/** Parse version string like "1.4.45" into [1, 4, 45] */
export function parseVersion(v: string): number[] {
    return v.split(".").map(Number);
}

export function compareVersion(a: string, b: string): number {
    const av = parseVersion(a), bv = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
}

/** Is this the client's first-ever asset download? */
export function isFirstTime(resVer?: string): boolean {
    return !resVer || compareVersion(CDN_BASELINE, resVer) > 0;
}

/**
 * Compute the target asset version for a client.
 * First-time: go to baseline. Update: go to server version if newer.
 */
export function getTargetVersion(resVer?: string): string {
    if (!resVer) return CDN_BASELINE;
    if (compareVersion(SERVER_VERSION, resVer) > 0) return SERVER_VERSION;
    return resVer;
}

/**
 * Load patch metadata from manifest.json.
 * Returns the maximum enabled patch version whose depends_on <= resVer.
 */
export interface PatchMeta {
    id: string;
    type: "patch" | "mod";
    name: string;
    version: string;
    depends_on: string;
    enabled: boolean;
}

let _manifestCache: { patches: PatchMeta[] } | null = null;

export function getPatchManifest(): { patches: PatchMeta[] } {
    if (_manifestCache) return _manifestCache;
    const manifestPath = path.join(__dirname, "..", "..", "assets", "asset-patch", "manifest.json");
    if (!existsSync(manifestPath)) {
        _manifestCache = { patches: [] };
        return _manifestCache;
    }
    _manifestCache = JSON.parse(readFileSync(manifestPath, "utf8"));
    return _manifestCache!;
}

/** Reload manifest cache (for admin toggle) */
export function reloadPatchManifest(): void {
    _manifestCache = null;
}

/**
 * Get the maximum enabled patch version for a given client version.
 * Only patches where depends_on <= resVer AND enabled=true are considered.
 */
export function getMaxPatchVersion(resVer?: string): string | null {
    if (!resVer) return null;
    const manifest = getPatchManifest();
    let maxV: string | null = null;
    for (const p of manifest.patches) {
        if (!p.enabled || p.type !== "patch") continue;
        if (compareVersion(p.depends_on, resVer) > 0) continue;
        if (!maxV || compareVersion(p.version, maxV) > 0) maxV = p.version;
    }
    return maxV;
}

/**
 * Compute the effective target version for get_path response.
 * Takes the maximum of: server version, highest enabled patch, CDN baseline.
 */
export function computeAssetTarget(resVer?: string): {
    targetVersion: string;
    isFirstTime: boolean;
    fullVersion: string;
} {
    const first = isFirstTime(resVer);
    if (first) {
        return {
            targetVersion: SERVER_VERSION,
            isFirstTime: true,
            fullVersion: CDN_BASELINE,
        };
    }
    // Non-first-time: target is server version if newer
    const patchMax = getMaxPatchVersion(resVer);
    const target = getTargetVersion(resVer);
    // If a patch is higher than the computed target, use patch version
    const effective = (patchMax && compareVersion(patchMax, target) > 0) ? patchMax : target;
    return {
        targetVersion: effective,
        isFirstTime: false,
        fullVersion: CDN_BASELINE,
    };
}
