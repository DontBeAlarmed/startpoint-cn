import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    mergeLegacyAndCharacterDiffs,
    maxCharacterReleaseVersion,
    readActiveCharacterReleases,
} from "../lib/cn-character-release";

function sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function fixture(): { root: string; active: string; cleanup: () => void } {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-char-release-"));
    const active = path.join(root, "character-releases", "active.json");
    mkdirSync(path.dirname(active), { recursive: true });
    return { root, active, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeRelease(root: string, active: string, options: { badSecond?: boolean } = {}): void {
    const releases: any[] = [];
    let from = "1.4.54";
    for (let index = 0; index < 2; index += 1) {
        const version = `1.4.${55 + index}`;
        const releaseId = `release-${index + 1}`;
        const archives = ["common", "medium", "android"].map(rootName => {
            const relativePath = `archive-${rootName}-diff/pinball-${from}-${version}-1-charpkg-seris_dragon_king-${releaseId}-${rootName}.zip`;
            const raw = Buffer.from(`archive-${index}-${rootName}`);
            const disk = path.join(root, ...relativePath.split("/"));
            mkdirSync(path.dirname(disk), { recursive: true });
            writeFileSync(disk, raw);
            return {
                root: rootName,
                relative_path: relativePath,
                size: raw.length,
                sha256: options.badSecond && index === 1 && rootName === "medium"
                    ? "0".repeat(64)
                    : sha256(raw),
            };
        });
        releases.push({
            release_id: releaseId,
            package_id: "seris_dragon_king",
            from_version: from,
            version,
            package_manifest_sha256: `${index + 1}`.repeat(64),
            archives,
        });
        from = version;
    }
    writeFileSync(active, JSON.stringify({
        schema_version: 1,
        base_version: "1.4.54",
        releases,
    }));
}

test("valid active chain is continuous and contributes complete three-root groups", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active);
        const chain = readActiveCharacterReleases(f.root);
        assert.equal(chain.error, null);
        assert.equal(chain.releases.length, 2);
        assert.equal(chain.tailVersion, "1.4.56");
        assert.equal(maxCharacterReleaseVersion(f.root), "1.4.56");
        assert.deepEqual(chain.releases.map(item => item.archives.length), [3, 3]);
    } finally {
        f.cleanup();
    }
});

test("bad archive hides that release and descendants while preserving valid prefix", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active, { badSecond: true });
        const chain = readActiveCharacterReleases(f.root);
        assert.match(chain.error ?? "", /archive hash\/size mismatch/);
        assert.equal(chain.releases.length, 1);
        assert.equal(chain.tailVersion, "1.4.55");
    } finally {
        f.cleanup();
    }
});

test("manifest validation is independent from the legacy directory tail", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active);
        const chain = readActiveCharacterReleases(f.root);
        assert.equal(chain.error, null);
        assert.equal(chain.baseVersion, "1.4.54");
        assert.equal(chain.releases.length, 2);
        assert.equal(chain.tailVersion, "1.4.56");
    } finally {
        f.cleanup();
    }
});

test("merge hides every unmanifested charpkg archive and adds only active groups", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active);
        const chain = readActiveCharacterReleases(f.root);
        const legacy = [{
            original_version: "1.4.53",
            version: "1.4.54",
            archive: [
                { location: "http://cdn/archive-common-diff/legacy.zip", size: 7, sha256: "" },
                { location: "http://cdn/archive-common-diff/unpublished-charpkg-x.zip", size: 8, sha256: "" },
            ],
        }];
        const merged = mergeLegacyAndCharacterDiffs(legacy, chain, "http://cdn");
        assert.equal(merged[0].archive.length, 1);
        assert.equal(merged.length, 3);
        assert.ok(merged.slice(1).every(group => group.archive.length === 3));
        assert.ok(merged.slice(1).flatMap(group => group.archive)
            .every(archive => archive.location.includes("-charpkg-")));
    } finally {
        f.cleanup();
    }
});
