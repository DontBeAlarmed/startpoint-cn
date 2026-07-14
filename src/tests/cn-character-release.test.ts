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
import { detectCDNVersion } from "../lib/version";

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
        const chain = readActiveCharacterReleases(f.root, "1.4.54");
        assert.equal(chain.error, null);
        assert.equal(chain.releases.length, 2);
        assert.equal(chain.tailVersion, "1.4.56");
        assert.equal(maxCharacterReleaseVersion(f.root, "1.4.54"), "1.4.56");
        assert.deepEqual(chain.releases.map(item => item.archives.length), [3, 3]);
    } finally {
        f.cleanup();
    }
});

test("bad archive hides that release and descendants while preserving valid prefix", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active, { badSecond: true });
        const chain = readActiveCharacterReleases(f.root, "1.4.54");
        assert.match(chain.error ?? "", /archive hash\/size mismatch/);
        assert.equal(chain.releases.length, 1);
        assert.equal(chain.tailVersion, "1.4.55");
    } finally {
        f.cleanup();
    }
});

test("detached manifest contributes no character release", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active);
        const chain = readActiveCharacterReleases(f.root, "1.4.53");
        assert.match(chain.error ?? "", /base_version/);
        assert.equal(chain.releases.length, 0);
        assert.equal(chain.tailVersion, "1.4.53");
    } finally {
        f.cleanup();
    }
});

test("merge hides every unmanifested charpkg archive and adds only active groups", () => {
    const f = fixture();
    try {
        writeRelease(f.root, f.active);
        const chain = readActiveCharacterReleases(f.root, "1.4.54");
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

test("asset route and effective version consume only the validated active chain", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "wf-char-route-"));
    const cdn = path.join(parent, "cn");
    const active = path.join(cdn, "character-releases", "active.json");
    mkdirSync(path.dirname(active), { recursive: true });
    const previous = process.env.CDN_DIR;
    const previousError = console.error;
    try {
        const legacyDir = path.join(cdn, "archive-common-diff");
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(
            path.join(legacyDir, "pinball-1.4.53-1.4.54-1-legacy.zip"),
            Buffer.from("legacy"),
        );
        writeFileSync(
            path.join(legacyDir, "pinball-1.4.54-1.4.99-1-unpublished-charpkg-x.zip"),
            Buffer.from("must stay hidden"),
        );
        writeRelease(cdn, active);
        process.env.CDN_DIR = parent;
        const expectedMissingFixtureLogs: unknown[][] = [];
        console.error = (...args: unknown[]) => { expectedMissingFixtureLogs.push(args); };
        const { buildDiffList } = require("../routes/cn/asset") as typeof import("../routes/cn/asset");
        const groups = buildDiffList("http://cdn", cdn);
        assert.deepEqual(groups.map(group => group.version), ["1.4.54", "1.4.55", "1.4.56"]);
        assert.ok(groups.flatMap(group => group.archive)
            .every(archive => !archive.location.includes("unpublished-charpkg")));
        assert.equal(detectCDNVersion(), "1.4.56");
        assert.ok(expectedMissingFixtureLogs.every(args => String(args[0]).includes("failed")));
    } finally {
        console.error = previousError;
        if (previous === undefined) delete process.env.CDN_DIR;
        else process.env.CDN_DIR = previous;
        rmSync(parent, { recursive: true, force: true });
    }
});
