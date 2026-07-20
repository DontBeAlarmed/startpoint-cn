/** Backward-compatible version facade over the process-pinned content snapshot. */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { getContentSnapshot } from "../content/runtime/content-snapshot";

// CDN full archives are at version 1.4.0
export const FULL_BASE = "1.4.0";

export function getEffectiveVersion(): string {
    return getContentSnapshot().cdn.targetVersion;
}

export function detectCDNVersion(): string {
    return getContentSnapshot().cdn.targetVersion;
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
