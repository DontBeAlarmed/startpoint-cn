import type {
    CatalogEdge,
    CdnCatalog,
    DiffCatalogEdge,
    PlanRequest,
    ReadonlyNonEmptyArray,
    UpdatePlan,
} from "./types"

export type CdnPlannerErrorCode =
    | "UNKNOWN_CURRENT_VERSION"
    | "NO_UPDATE_PATH"
    | "AMBIGUOUS_UPDATE_PATH"
    | "UNSUPPORTED_PLATFORM"
    | "INVALID_DOWNLOAD_BYTES"

export class CdnPlannerError extends Error {
    readonly code: CdnPlannerErrorCode

    constructor(code: CdnPlannerErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "CdnPlannerError"
        this.code = code
    }
}

function archiveBytes(edges: ReadonlyArray<CatalogEdge>): number {
    let total = 0
    for (const edge of edges) {
        for (const archive of edge.archives) {
            if (!Number.isSafeInteger(archive.compressedBytes)
                || archive.compressedBytes < 0
                || !Number.isSafeInteger(total + archive.compressedBytes)) {
                throw new CdnPlannerError(
                    "INVALID_DOWNLOAD_BYTES",
                    `archive ${archive.relativePath} exceeds the safe download byte range`,
                )
            }
            total += archive.compressedBytes
        }
    }
    return total
}

function edgeSortKey(edge: DiffCatalogEdge): string {
    return JSON.stringify([
        edge.fromVersion,
        edge.toVersion,
        edge.archives.map(archive => [
            archive.relativePath,
            archive.compressedBytes,
            archive.sha256,
            archive.layer,
            archive.order,
        ]),
    ])
}

function findPaths(
    edges: ReadonlyArray<DiffCatalogEdge>,
    fromVersion: string,
    targetVersion: string,
): ReadonlyArray<ReadonlyArray<DiffCatalogEdge>> {
    const paths: DiffCatalogEdge[][] = []
    const adjacency = new Map<string, DiffCatalogEdge[]>()
    for (const edge of edges) {
        const outgoing = adjacency.get(edge.fromVersion) ?? []
        outgoing.push(edge)
        adjacency.set(edge.fromVersion, outgoing)
    }
    for (const outgoing of adjacency.values()) {
        outgoing.sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right)))
    }

    const visit = (version: string, path: DiffCatalogEdge[], visited: Set<string>): void => {
        if (paths.length > 1) return
        if (version === targetVersion) {
            paths.push([...path])
            return
        }
        if (visited.has(version)) return

        const nextVisited = new Set(visited)
        nextVisited.add(version)
        for (const edge of adjacency.get(version) ?? []) {
            visit(edge.toVersion, [...path, edge], nextVisited)
            if (paths.length > 1) return
        }
    }

    visit(fromVersion, [], new Set())
    return paths
}

function uniquePath(
    edges: ReadonlyArray<DiffCatalogEdge>,
    fromVersion: string,
    targetVersion: string,
): ReadonlyArray<DiffCatalogEdge> {
    const paths = findPaths(edges, fromVersion, targetVersion)
    if (paths.length === 0) {
        throw new CdnPlannerError(
            "NO_UPDATE_PATH",
            `no update path from ${fromVersion} to ${targetVersion}`,
        )
    }
    if (paths.length > 1) {
        throw new CdnPlannerError(
            "AMBIGUOUS_UPDATE_PATH",
            `multiple update paths from ${fromVersion} to ${targetVersion}`,
        )
    }
    return paths[0]
}

function asNonEmptyPath(
    path: ReadonlyArray<DiffCatalogEdge>,
): ReadonlyNonEmptyArray<DiffCatalogEdge> | null {
    return path.length === 0
        ? null
        : path as ReadonlyNonEmptyArray<DiffCatalogEdge>
}

export function planCdnUpdate(catalog: CdnCatalog, request: PlanRequest): UpdatePlan {
    if ((request as { platform?: unknown }).platform !== "android") {
        throw new CdnPlannerError("UNSUPPORTED_PLATFORM", "only android is supported")
    }
    if (typeof (request as { targetVersion?: unknown }).targetVersion !== "string") {
        throw new CdnPlannerError("NO_UPDATE_PATH", "target version must be a string")
    }
    if (request.currentVersion !== null && typeof request.currentVersion !== "string") {
        throw new CdnPlannerError("UNKNOWN_CURRENT_VERSION", "current version must be a string or null")
    }

    const scopedEdges = catalog.edges.filter(candidate => (
        candidate.platform === "android"
        && candidate.assetSizeKind === "fulfill"
    ))
    const scopedDiffs = scopedEdges.filter((candidate): candidate is DiffCatalogEdge => (
        candidate.fromVersion !== null
    ))
    if (!request.isInitial) {
        const knownVersions = new Set<string>([catalog.fullBaseVersion])
        for (const edge of scopedEdges) {
            if (edge.fromVersion !== null) knownVersions.add(edge.fromVersion)
            knownVersions.add(edge.toVersion)
        }
        if (request.currentVersion === null || !knownVersions.has(request.currentVersion)) {
            throw new CdnPlannerError(
                "UNKNOWN_CURRENT_VERSION",
                `unknown current version ${String(request.currentVersion)}`,
            )
        }
    }

    if (!request.isInitial && request.currentVersion === request.targetVersion) {
        return {
            kind: "up-to-date" as const,
            full: null,
            diff: null,
            downloadBytes: 0,
            delayedAssetsBytes: 0 as const,
        }
    }
    if (request.isInitial) {
        const full = catalog.edges.find(candidate => (
            candidate.fromVersion === null
            && candidate.toVersion === catalog.fullBaseVersion
            && candidate.platform === "android"
            && candidate.assetSizeKind === "fulfill"
        ))
        if (!full || full.fromVersion !== null) {
            throw new CdnPlannerError("NO_UPDATE_PATH", "full base archive is unavailable")
        }
        const diff = uniquePath(scopedDiffs, catalog.fullBaseVersion, request.targetVersion)
        const initialDiff = asNonEmptyPath(diff)
        return {
            kind: "initial" as const,
            full,
            diff: initialDiff,
            downloadBytes: archiveBytes([full, ...diff]),
            delayedAssetsBytes: 0 as const,
        }
    }

    const diff = uniquePath(scopedDiffs, request.currentVersion as string, request.targetVersion)
    const incrementalDiff = asNonEmptyPath(diff)
    if (incrementalDiff === null) {
        throw new CdnPlannerError("NO_UPDATE_PATH", "incremental update path must not be empty")
    }

    return {
        kind: "incremental" as const,
        full: null,
        diff: incrementalDiff,
        downloadBytes: archiveBytes(diff),
        delayedAssetsBytes: 0 as const,
    }
}
