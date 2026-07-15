import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
    CharacterRoot,
    readActiveCharacterReleases,
    ValidatedReleaseChain,
} from "./cn-character-release";


export type ReleaseArchiveRoot = CharacterRoot | "patch";

export interface ReleaseArchive {
    root: ReleaseArchiveRoot;
    relativePath: string;
    size: number;
    sha256: string;
    source: string;
}

export interface ReleaseEdge {
    from: string;
    to: string;
    archives: ReleaseArchive[];
    sources: string[];
}

export interface SupportedReleaseBase {
    baseVersion: string;
    targetVersion: string;
    reachable: boolean;
    edgeCount: number;
}

export interface ReleaseGraphSnapshot {
    fullBase: string;
    tailVersion: string;
    edges: ReleaseEdge[];
    outgoing: ReadonlyMap<string, ReleaseEdge[]>;
    supported: SupportedReleaseBase[];
    issues: string[];
    cdnDir: string;
    assetPatchRoot: string;
}

export interface ReleaseGraphInput {
    cdnDir: string;
    assetPatchRoot: string;
    fullBase?: string;
    supportedBases?: string[];
    characterChain?: ValidatedReleaseChain;
}

export interface ReleasePathResult {
    startVersion: string;
    targetVersion: string;
    edges: ReleaseEdge[];
}


const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ARCHIVE_RE = /^pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-([1-9]\d*)-(.+)\.zip$/;
const LEGACY_ROOTS: Array<{ root: CharacterRoot, directory: string }> = [
    { root: "common", directory: "archive-common-diff" },
    { root: "medium", directory: "archive-medium-diff" },
    { root: "android", directory: "archive-android-diff" },
];
const ROOT_ORDER: Record<ReleaseArchiveRoot, number> = {
    common: 0,
    medium: 1,
    android: 2,
    patch: 3,
};


export function compareReleaseVersions(left: string, right: string): number {
    if (!VERSION_RE.test(left) || !VERSION_RE.test(right)) {
        return left.localeCompare(right);
    }
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
    }
    return 0;
}


function edgeKey(from: string, to: string): string {
    return `${from}\u0000${to}`;
}


function archiveOrder(left: ReleaseArchive, right: ReleaseArchive): number {
    return ROOT_ORDER[left.root] - ROOT_ORDER[right.root]
        || left.relativePath.localeCompare(right.relativePath)
        || left.source.localeCompare(right.source);
}


function edgeOrder(left: ReleaseEdge, right: ReleaseEdge): number {
    return compareReleaseVersions(left.to, right.to)
        || compareReleaseVersions(left.from, right.from)
        || left.sources.join("\u0000").localeCompare(right.sources.join("\u0000"))
        || left.archives.map(item => item.relativePath).join("\u0000")
            .localeCompare(right.archives.map(item => item.relativePath).join("\u0000"));
}


function reachablePaths(
    graph: Pick<ReleaseGraphSnapshot, "outgoing">,
    startVersion: string,
): Map<string, ReleaseEdge[]> {
    const best = new Map<string, ReleaseEdge[]>([[startVersion, []]]);
    const queue = [startVersion];
    while (queue.length > 0) {
        const version = queue.shift()!;
        const current = best.get(version)!;
        for (const edge of graph.outgoing.get(version) ?? []) {
            const candidate = [...current, edge];
            const previous = best.get(edge.to);
            if (previous !== undefined && previous.length <= candidate.length) continue;
            best.set(edge.to, candidate);
            queue.push(edge.to);
        }
    }
    return best;
}


export function findReleasePath(
    graph: Pick<ReleaseGraphSnapshot, "outgoing">,
    startVersion: string,
): ReleasePathResult {
    const reachable = reachablePaths(graph, startVersion);
    let targetVersion = startVersion;
    let edges: ReleaseEdge[] = [];
    for (const [version, candidate] of reachable) {
        const comparison = compareReleaseVersions(version, targetVersion);
        if (comparison > 0 || (comparison === 0 && candidate.length < edges.length)) {
            targetVersion = version;
            edges = candidate;
        }
    }
    return { startVersion, targetVersion, edges };
}


interface EdgeBuilder {
    from: string;
    to: string;
    archives: ReleaseArchive[];
    sources: Set<string>;
    archiveKeys: Set<string>;
}


function archiveFromDisk(
    disk: string,
    root: ReleaseArchiveRoot,
    relativePath: string,
    source: string,
): ReleaseArchive | null {
    try {
        const stats = statSync(disk);
        if (!stats.isFile() || stats.size <= 0) return null;
        return {
            root,
            relativePath: relativePath.replace(/\\/g, "/"),
            size: stats.size,
            sha256: "",
            source,
        };
    } catch {
        return null;
    }
}


function normalizedBases(fullBase: string, configured: string[] | undefined): string[] {
    const result: string[] = [];
    for (const version of [fullBase, ...(configured ?? [])]) {
        const trimmed = version.trim();
        if (trimmed && !result.includes(trimmed)) result.push(trimmed);
    }
    return result;
}


export function parseSupportedAssetBases(raw: string | undefined): string[] {
    return raw === undefined
        ? []
        : raw.split(",").map(item => item.trim()).filter((item, index, all) => (
            item !== "" && all.indexOf(item) === index
        ));
}


export function resolveAssetPatchRoot(): string {
    return path.resolve(__dirname, "..", "..", "assets", "asset-patch");
}


export function buildReleaseGraph(input: ReleaseGraphInput): ReleaseGraphSnapshot {
    const cdnDir = path.resolve(input.cdnDir);
    const assetPatchRoot = path.resolve(input.assetPatchRoot);
    const fullBase = input.fullBase ?? "1.4.0";
    const issues: string[] = [];
    const builders = new Map<string, EdgeBuilder>();

    const addArchive = (
        from: string,
        to: string,
        archive: ReleaseArchive,
        source: string,
    ): void => {
        if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) {
            issues.push(`invalid release edge ${from}->${to} from ${source}`);
            return;
        }
        if (compareReleaseVersions(to, from) <= 0) {
            issues.push(`non-increasing backward/cycle edge ${from}->${to} from ${source}`);
            return;
        }
        const key = edgeKey(from, to);
        let builder = builders.get(key);
        if (!builder) {
            builder = { from, to, archives: [], sources: new Set(), archiveKeys: new Set() };
            builders.set(key, builder);
        }
        const archiveKey = `${archive.root}\u0000${archive.relativePath}\u0000${archive.source}`;
        if (!builder.archiveKeys.has(archiveKey)) {
            builder.archiveKeys.add(archiveKey);
            builder.archives.push(archive);
        }
        builder.sources.add(source);
    };

    const scan = (
        directory: string,
        root: ReleaseArchiveRoot,
        relativePrefix: string,
        source: string,
        hideCharacterPackages: boolean,
    ): void => {
        if (!existsSync(directory)) {
            issues.push(`release archive directory is missing: ${directory}`);
            return;
        }
        let names: string[];
        try {
            names = readdirSync(directory).filter(name => name.endsWith(".zip")).sort();
        } catch (error) {
            issues.push(`release archive directory unreadable: ${directory}: ${(error as Error).message}`);
            return;
        }
        for (const name of names) {
            if (hideCharacterPackages && name.includes("-charpkg-")) continue;
            const match = ARCHIVE_RE.exec(name);
            if (!match) {
                issues.push(`release archive filename is invalid: ${path.join(directory, name)}`);
                continue;
            }
            const archive = archiveFromDisk(
                path.join(directory, name),
                root,
                `${relativePrefix}/${name}`,
                source,
            );
            if (!archive) {
                issues.push(`release archive is missing or empty: ${path.join(directory, name)}`);
                continue;
            }
            addArchive(match[1], match[2], archive, source);
        }
    };

    for (const item of LEGACY_ROOTS) {
        scan(
            path.join(cdnDir, item.directory),
            item.root,
            item.directory,
            `legacy:${item.root}`,
            true,
        );
    }
    scan(
        path.join(assetPatchRoot, "active"),
        "patch",
        "asset-patch/active",
        "asset-patch:active",
        false,
    );

    const characterChain = input.characterChain ?? readActiveCharacterReleases(cdnDir);
    if (characterChain.error) issues.push(`character release: ${characterChain.error}`);
    for (const release of characterChain.releases) {
        for (const archive of release.archives) {
            addArchive(release.from_version, release.version, {
                root: archive.root,
                relativePath: archive.relative_path,
                size: archive.size,
                sha256: archive.sha256,
                source: `character:${release.release_id}`,
            }, `character:${release.release_id}`);
        }
    }

    const edges = [...builders.values()].map(builder => ({
        from: builder.from,
        to: builder.to,
        archives: builder.archives.sort(archiveOrder),
        sources: [...builder.sources].sort(),
    })).sort((left, right) => (
        compareReleaseVersions(left.from, right.from) || edgeOrder(left, right)
    ));
    const outgoing = new Map<string, ReleaseEdge[]>();
    for (const edge of edges) {
        const list = outgoing.get(edge.from) ?? [];
        list.push(edge);
        outgoing.set(edge.from, list);
    }
    for (const list of outgoing.values()) list.sort(edgeOrder);

    const partial: ReleaseGraphSnapshot = {
        fullBase,
        tailVersion: fullBase,
        edges,
        outgoing,
        supported: [],
        issues,
        cdnDir,
        assetPatchRoot,
    };
    const fromFull = reachablePaths(partial, fullBase);
    const fullPath = findReleasePath(partial, fullBase);
    partial.tailVersion = fullPath.targetVersion;

    for (const edge of edges) {
        if (!fromFull.has(edge.from)) {
            issues.push(`isolated/unreachable release edge from ${fullBase}: ${edge.from}->${edge.to}`);
        }
    }
    if (characterChain.releases.length > 0 && !fromFull.has(characterChain.baseVersion)) {
        issues.push(`character release base is unreachable: ${characterChain.baseVersion}`);
    }

    partial.supported = normalizedBases(fullBase, input.supportedBases).map(baseVersion => {
        if (!VERSION_RE.test(baseVersion)) {
            issues.push(`supported asset base is invalid: ${baseVersion}`);
            return { baseVersion, targetVersion: baseVersion, reachable: false, edgeCount: 0 };
        }
        const releasePath = findReleasePath(partial, baseVersion);
        const reachable = releasePath.targetVersion === partial.tailVersion;
        if (!reachable) {
            issues.push(
                `supported asset base cannot reach ${partial.tailVersion}: ${baseVersion} stops at ${releasePath.targetVersion}`,
            );
        }
        return {
            baseVersion,
            targetVersion: releasePath.targetVersion,
            reachable,
            edgeCount: releasePath.edges.length,
        };
    });
    partial.issues = [...new Set(issues)];
    return partial;
}
