import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    buildReleaseGraph,
    findReleasePath,
    getCnReleaseGraphSnapshot,
    resetCnReleaseGraphCache,
} from "../lib/cn-asset-graph";
import type { ReleaseGraphSnapshot } from "../lib/cn-asset-graph";
import { computeAssetTarget } from "../lib/version";
import { buildDiffList } from "../routes/cn/asset";


const DIFF_DIRS = {
    common: "archive-common-diff",
    medium: "archive-medium-diff",
    android: "archive-android-diff",
} as const;


function sha256(raw: Buffer): string {
    return createHash("sha256").update(raw).digest("hex");
}


interface GraphFixture {
    root: string;
    cdnDir: string;
    assetPatchRoot: string;
    activeManifest: string;
    cleanup(): void;
}


function fixture(): GraphFixture {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-release-graph-"));
    const cdnDir = path.join(root, "cdn");
    const assetPatchRoot = path.join(root, "asset-patch");
    for (const directory of Object.values(DIFF_DIRS)) {
        mkdirSync(path.join(cdnDir, directory), { recursive: true });
    }
    mkdirSync(path.join(cdnDir, "character-releases"), { recursive: true });
    mkdirSync(path.join(assetPatchRoot, "active"), { recursive: true });
    return {
        root,
        cdnDir,
        assetPatchRoot,
        activeManifest: path.join(cdnDir, "character-releases", "active.json"),
        cleanup() {
            const resolved = path.resolve(root);
            const temp = path.resolve(os.tmpdir());
            assert.ok(resolved.startsWith(`${temp}${path.sep}`));
            assert.ok(path.basename(resolved).startsWith("wf-release-graph-"));
            rmSync(resolved, { recursive: true, force: true });
        },
    };
}


function writeLegacy(
    f: GraphFixture,
    from: string,
    to: string,
    root: keyof typeof DIFF_DIRS = "common",
    label = "fixture",
): string {
    const name = `pinball-${from}-${to}-1-${label}.zip`;
    writeFileSync(path.join(f.cdnDir, DIFF_DIRS[root], name), Buffer.from(`${root}:${from}:${to}:${label}`));
    return name;
}


function writePatch(f: GraphFixture, from: string, to: string, label = "patch"): string {
    const name = `pinball-${from}-${to}-1-${label}.zip`;
    writeFileSync(path.join(f.assetPatchRoot, "active", name), Buffer.from(`patch:${from}:${to}:${label}`));
    return name;
}


interface CharacterOptions {
    corruptRelease?: number;
    missingRelease?: number;
    missingRoot?: keyof typeof DIFF_DIRS;
}


function writeCharacterChain(
    f: GraphFixture,
    basePatch: number,
    tailPatch: number,
    options: CharacterOptions = {},
): void {
    const releases: any[] = [];
    for (let patchValue = basePatch; patchValue < tailPatch; patchValue += 1) {
        const from = `1.4.${patchValue}`;
        const to = `1.4.${patchValue + 1}`;
        const releaseIndex = patchValue - basePatch;
        const releaseId = `release-${releaseIndex + 1}`;
        const archives = (Object.keys(DIFF_DIRS) as Array<keyof typeof DIFF_DIRS>).map(root => {
            const relative = `${DIFF_DIRS[root]}/pinball-${from}-${to}-1-charpkg-fixture-${releaseId}-${root}.zip`;
            const raw = Buffer.from(`character:${releaseIndex}:${root}`);
            const disk = path.join(f.cdnDir, ...relative.split("/"));
            writeFileSync(disk, raw);
            if (options.missingRelease === releaseIndex && options.missingRoot === root) unlinkSync(disk);
            return {
                root,
                relative_path: relative,
                size: raw.length,
                sha256: options.corruptRelease === releaseIndex && root === "medium"
                    ? "0".repeat(64)
                    : sha256(raw),
            };
        });
        releases.push({
            release_id: releaseId,
            package_id: "fixture",
            from_version: from,
            version: to,
            package_manifest_sha256: `${releaseIndex + 1}`.repeat(64),
            archives,
        });
    }
    writeFileSync(f.activeManifest, JSON.stringify({
        schema_version: 1,
        base_version: `1.4.${basePatch}`,
        releases,
    }));
}


function build(
    f: GraphFixture,
    fullBase: string,
    supportedBases: string[] = [fullBase],
): ReleaseGraphSnapshot {
    return buildReleaseGraph({
        cdnDir: f.cdnDir,
        assetPatchRoot: f.assetPatchRoot,
        fullBase,
        supportedBases,
    });
}


test("character chain may attach at a reachable earlier node and merge four roots", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.102", "1.4.133");
        writeLegacy(f, "1.4.138", "1.4.139");
        writePatch(f, "1.4.138", "1.4.139");
        writeCharacterChain(f, 133, 140);
        const graph = build(f, "1.4.102", ["1.4.102", "1.4.133"]);
        const result = findReleasePath(graph, "1.4.102");
        assert.equal(result.targetVersion, "1.4.140");
        assert.deepEqual(result.edges.map(edge => `${edge.from}->${edge.to}`), [
            "1.4.102->1.4.133",
            "1.4.133->1.4.134",
            "1.4.134->1.4.135",
            "1.4.135->1.4.136",
            "1.4.136->1.4.137",
            "1.4.137->1.4.138",
            "1.4.138->1.4.139",
            "1.4.139->1.4.140",
        ]);
        const merged = graph.edges.find(edge => edge.from === "1.4.138" && edge.to === "1.4.139");
        assert.ok(merged);
        assert.deepEqual(
            new Set(merged.archives.map(archive => archive.root)),
            new Set(["common", "medium", "android", "patch"]),
        );
        assert.equal(graph.issues.length, 0);
        assert.ok(graph.supported.every(item => item.reachable));
    } finally {
        f.cleanup();
    }
});


for (const failure of ["corrupt", "missing"] as const) {
    test(`${failure} character archive truncates the manifest chain`, () => {
        const f = fixture();
        try {
            writeCharacterChain(f, 133, 135, failure === "corrupt"
                ? { corruptRelease: 0 }
                : { missingRelease: 0, missingRoot: "android" });
            const graph = build(f, "1.4.133");
            assert.equal(graph.tailVersion, "1.4.133");
            assert.equal(graph.edges.length, 0);
            assert.match(graph.issues.join("\n"), failure === "corrupt" ? /hash\/size mismatch/ : /missing/);
        } finally {
            f.cleanup();
        }
    });
}


test("backward cycle edge is rejected", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.0", "1.4.1");
        writeLegacy(f, "1.4.1", "1.4.0", "common", "cycle");
        const graph = build(f, "1.4.0");
        assert.equal(graph.edges.length, 1);
        assert.match(graph.issues.join("\n"), /backward|cycle|non-increasing/);
    } finally {
        f.cleanup();
    }
});


test("isolated high version is reported without becoming the tail", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.0", "1.4.1");
        writeLegacy(f, "9.0.0", "9.0.1", "common", "isolated");
        const graph = build(f, "1.4.0");
        assert.equal(graph.tailVersion, "1.4.1");
        assert.match(graph.issues.join("\n"), /isolated|unreachable/);
        assert.equal(findReleasePath(graph, "1.4.0").targetVersion, "1.4.1");
    } finally {
        f.cleanup();
    }
});


test("path selection is shortest and deterministic for the highest target", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.0", "1.4.1", "common", "a");
        writeLegacy(f, "1.4.0", "1.4.2", "common", "b");
        writeLegacy(f, "1.4.1", "1.4.5", "common", "c");
        writeLegacy(f, "1.4.2", "1.4.5", "common", "d");
        let graph = build(f, "1.4.0");
        assert.deepEqual(
            findReleasePath(graph, "1.4.0").edges.map(edge => edge.to),
            ["1.4.1", "1.4.5"],
        );

        writeLegacy(f, "1.4.0", "1.4.5", "common", "direct");
        graph = build(f, "1.4.0");
        assert.deepEqual(
            findReleasePath(graph, "1.4.0").edges.map(edge => edge.to),
            ["1.4.5"],
        );
    } finally {
        f.cleanup();
    }
});


test("every declared supported base is evaluated against the canonical tail", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.0", "1.4.1");
        writeLegacy(f, "1.4.1", "1.4.2");
        const graph = build(f, "1.4.0", ["1.4.0", "1.4.1", "1.4.2"]);
        assert.equal(graph.tailVersion, "1.4.2");
        assert.deepEqual(graph.supported.map(item => ({
            base: item.baseVersion,
            target: item.targetVersion,
            reachable: item.reachable,
        })), [
            { base: "1.4.0", target: "1.4.2", reachable: true },
            { base: "1.4.1", target: "1.4.2", reachable: true },
            { base: "1.4.2", target: "1.4.2", reachable: true },
        ]);
    } finally {
        f.cleanup();
    }
});


test("load and get_path choose the same reachable target from an injected snapshot", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.102", "1.4.133");
        writePatch(f, "1.4.138", "1.4.139", "fixture-active");
        writeCharacterChain(f, 133, 140);
        const graph = build(f, "1.4.102", ["1.4.102", "1.4.133"]);

        const target = computeAssetTarget("1.4.102", graph);
        assert.equal(target.targetVersion, "1.4.140");
        assert.deepEqual(target.path.edges.map(edge => edge.to), [
            "1.4.133",
            "1.4.134",
            "1.4.135",
            "1.4.136",
            "1.4.137",
            "1.4.138",
            "1.4.139",
            "1.4.140",
        ]);

        const groups = buildDiffList("http://cdn", graph);
        assert.deepEqual(groups.map(group => group.version), target.path.edges.map(edge => edge.to));
        assert.ok(groups.flatMap(group => group.archive).some(archive => (
            archive.location.includes("/asset-patch/active/")
            && archive.location.includes("fixture-active")
        )));
        assert.ok(groups.flatMap(group => group.archive).every(archive => (
            archive.location.startsWith("http://cdn/")
        )));
    } finally {
        f.cleanup();
    }
});


test("a disconnected client keeps its current version and receives no diff path", () => {
    const f = fixture();
    try {
        writeLegacy(f, "1.4.102", "1.4.133");
        writeCharacterChain(f, 133, 140);
        const graph = build(f, "1.4.102");

        const target = computeAssetTarget("1.4.120", graph);
        assert.equal(target.isFirstTime, false);
        assert.equal(target.fullVersion, "1.4.120");
        assert.equal(target.targetVersion, "1.4.120");
        assert.deepEqual(target.path.edges, []);
        assert.deepEqual(buildDiffList("http://cdn", graph, target.path), []);
    } finally {
        f.cleanup();
    }
});


// 2026-07-18 链重锚事故回归:base_version 抬高后,被 active.json 丢弃的
// charpkg 历史边因文件名过滤从 graph 消失,停在中间版本的客户端塌回"已最新"。
// charbridge 命名的硬链接副本(非 charpkg)必须能把老客户端重新接回 tail。
test("re-anchored chain strands old clients until charbridge copies restore the path", () => {
    const f = fixture();
    const roots = Object.keys(DIFF_DIRS) as Array<keyof typeof DIFF_DIRS>;
    const writeHistory = (label: string): void => {
        for (let patch = 133; patch < 140; patch += 1) {
            for (const root of roots) {
                writeLegacy(f, `1.4.${patch}`, `1.4.${patch + 1}`, root, `${label}-old-${root}`);
            }
        }
    };
    try {
        writeLegacy(f, "1.4.0", "1.4.133");
        writeLegacy(f, "1.4.140", "1.4.141");
        writeHistory("charpkg-fixture");
        writeCharacterChain(f, 141, 143);

        const stranded = build(f, "1.4.0");
        assert.equal(stranded.tailVersion, "1.4.133");
        assert.equal(findReleasePath(stranded, "1.4.136").targetVersion, "1.4.136");
        assert.match(
            stranded.issues.join("\n"),
            /character release base is unreachable: 1\.4\.141/,
        );

        writeHistory("charbridge-fixture");
        const bridged = build(f, "1.4.0");
        assert.equal(bridged.tailVersion, "1.4.143");
        assert.deepEqual(bridged.issues, []);
        assert.equal(findReleasePath(bridged, "1.4.133").targetVersion, "1.4.143");
        assert.equal(findReleasePath(bridged, "1.4.136").targetVersion, "1.4.143");
        assert.equal(computeAssetTarget("1.4.136", bridged).targetVersion, "1.4.143");
    } finally {
        f.cleanup();
    }
});


test("cached snapshots invalidate when a diff directory changes", () => {
    const f = fixture();
    resetCnReleaseGraphCache();
    try {
        writeLegacy(f, "1.4.0", "1.4.1");
        const options = {
            cdnDir: f.cdnDir,
            assetPatchRoot: f.assetPatchRoot,
            fullBase: "1.4.0",
            supportedBases: ["1.4.0"],
        };
        const first = getCnReleaseGraphSnapshot(options);
        const cached = getCnReleaseGraphSnapshot(options);
        assert.equal(cached, first);
        assert.equal(first.tailVersion, "1.4.1");
        assert.ok(Object.isFrozen(first));
        assert.ok(Object.isFrozen(first.edges));

        writeLegacy(f, "1.4.1", "1.4.2", "medium", "cache-invalidation");
        const rebuilt = getCnReleaseGraphSnapshot(options);
        assert.notEqual(rebuilt, first);
        assert.equal(rebuilt.tailVersion, "1.4.2");
    } finally {
        resetCnReleaseGraphCache();
        f.cleanup();
    }
});
