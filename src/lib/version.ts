/**
 * Unified version control for CN asset update.
 * 
 * CDN_VERSION is auto-detected from diff archive filenames.
 * CN_RES_VERSION in .env is OBSOLETE — version is derived from CDN + enabled patches.
 * 
 * Flow:
 *   1st-time (no resVer): full.version="1.4.0", full.archives=all, target=CDN_VERSION
 *   Update  (resVer<target):  full.version=resVer, full.archives=[], target=max(CDN, patches)
 *   Up-to-date (resVer≥target): same als update but no diffs to download
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";

// CDN full archives are at version 1.4.0
export const FULL_BASE = "1.4.0";

// Detect highest version from CDN diff archives + enabled patches
export function getEffectiveVersion(): string {
    const cdnVer = detectCDNVersion();
    // Scan ALL enabled patches for max version (not filtered by depends_on)
    const manifest = getPatchManifest();
    let maxPatchVer: string | null = null;
    for (const p of manifest.patches) {
        if (!p.enabled || p.type !== "patch") continue;
        if (!maxPatchVer || compareVersion(p.version, maxPatchVer) > 0) maxPatchVer = p.version;
    }
    if (maxPatchVer && compareVersion(maxPatchVer, cdnVer) > 0) return maxPatchVer;
    return cdnVer;
}

// Detect highest version from CDN diff archive filenames.
// Cache invalidates on diff-dir mtime change so newly published archives
// take effect without a server restart.
let _cdnVersion: string | null = null;
let _cdnStamp = "";

const CDN_DIFF_DIRS = ["archive-common-diff", "archive-medium-diff", "archive-android-diff"];

export function detectCDNVersion(): string {
    const cdnDir = path.join(__dirname, "..", "..", ".cdn", "cn");
    const stamp = CDN_DIFF_DIRS
        .map(d => { try { return statSync(path.join(cdnDir, d)).mtimeMs; } catch (_) { return 0; } })
        .join(",");
    if (_cdnVersion && stamp === _cdnStamp) return _cdnVersion;
    let max = "1.4.0";
    for (const subdir of CDN_DIFF_DIRS) {
        const dir = path.join(cdnDir, subdir);
        try {
            for (const f of readdirSync(dir).filter(f => f.endsWith(".zip"))) {
                const m = f.match(/pinball-\d+\.\d+\.\d+-(\d+\.\d+\.\d+)-\d+-/);
                if (m && compareVersion(m[1], max) > 0) max = m[1];
            }
        } catch (_) { /* ignore */ }
    }
    _cdnVersion = max;
    _cdnStamp = stamp;
    return max;
}

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

export interface PatchMeta {
    id: string; type: "patch" | "mod"; name: string;
    version: string; depends_on: string; enabled: boolean;
}

let _manifestCache: { cdn_version: string; patches: PatchMeta[] } | null = null;

export function getPatchManifest(): { cdn_version: string; patches: PatchMeta[] } {
    if (_manifestCache) return _manifestCache;
    const mp = path.join(__dirname, "..", "..", "assets", "asset-patch", "manifest.json");
    if (!existsSync(mp)) { _manifestCache = { cdn_version: "1.4.54", patches: [] }; return _manifestCache!; }
    _manifestCache = JSON.parse(readFileSync(mp, "utf8"));
    return _manifestCache!;
}

export function reloadPatchManifest(): void { _manifestCache = null; }

// Max enabled patch version whose depends_on <= resVer
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

export function isFirstTime(resVer?: string): boolean {
    return !resVer || compareVersion(FULL_BASE, resVer) > 0;
}

/**
 * Compute asset update response for a client.
 * 1st-time: full download to CDN_VERSION + applicable patches.
 * Update:   only diff from resVer to effective version.
 */
export function computeAssetTarget(resVer?: string): {
    targetVersion: string;
    isFirstTime: boolean;
    fullVersion: string;
} {
    if (isFirstTime(resVer)) {
        return {
            targetVersion: getEffectiveVersion(),
            isFirstTime: true,
            fullVersion: FULL_BASE,
        };
    }
    // Non-first-time: client already has full CDN data
    const effective = getEffectiveVersion();
    const target = compareVersion(effective, resVer!) > 0 ? effective : resVer!;
    return {
        targetVersion: target,
        isFirstTime: false,
        fullVersion: resVer!,  // tell client its current version = its full version
    };
}
