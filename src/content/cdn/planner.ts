import type {
    CatalogEdge,
    CdnCatalog,
    DiffCatalogEdge,
    FullCatalogEdge,
    PlanRequest,
    ReadonlyNonEmptyArray,
    UpdatePlan,
} from "./types"

export type CdnPlannerErrorCode =
    | "UNKNOWN_CURRENT_VERSION"
    | "NO_UPDATE_PATH"
    | "AMBIGUOUS_UPDATE_PATH"
    | "UNSUPPORTED_PLATFORM"
    | "UNSUPPORTED_ASSET_SIZE_KIND"
    | "INVALID_DOWNLOAD_BYTES"
    | "INVALID_CATALOG"

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

interface DiffGraph {
    readonly adjacency: ReadonlyMap<string, ReadonlyArray<DiffCatalogEdge>>
    readonly topologicalOrder: ReadonlyArray<string>
}

function buildDiffGraph(edges: ReadonlyArray<DiffCatalogEdge>): DiffGraph {
    const adjacency = new Map<string, DiffCatalogEdge[]>()
    const indegree = new Map<string, number>()
    for (const edge of edges) {
        const outgoing = adjacency.get(edge.fromVersion) ?? []
        outgoing.push(edge)
        adjacency.set(edge.fromVersion, outgoing)
        if (!indegree.has(edge.fromVersion)) indegree.set(edge.fromVersion, 0)
        indegree.set(edge.toVersion, (indegree.get(edge.toVersion) ?? 0) + 1)
    }
    for (const outgoing of adjacency.values()) {
        outgoing.sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right)))
    }

    const queue = [...indegree.entries()]
        .filter(([, count]) => count === 0)
        .map(([version]) => version)
        .sort((left, right) => left.localeCompare(right))
    const topologicalOrder: string[] = []
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const version = queue[queueIndex]
        topologicalOrder.push(version)
        for (const edge of adjacency.get(version) ?? []) {
            const nextIndegree = (indegree.get(edge.toVersion) as number) - 1
            indegree.set(edge.toVersion, nextIndegree)
            if (nextIndegree === 0) queue.push(edge.toVersion)
        }
    }

    if (topologicalOrder.length !== indegree.size) {
        throw new CdnPlannerError("INVALID_CATALOG", "diff graph contains a cycle")
    }
    return { adjacency, topologicalOrder }
}

function countPathsToTarget(graph: DiffGraph, targetVersion: string): ReadonlyMap<string, number> {
    const pathCounts = new Map<string, number>([[targetVersion, 1]])
    for (let index = graph.topologicalOrder.length - 1; index >= 0; index--) {
        const version = graph.topologicalOrder[index]
        if (version === targetVersion) continue

        let count = 0
        for (const edge of graph.adjacency.get(version) ?? []) {
            count = Math.min(2, count + (pathCounts.get(edge.toVersion) ?? 0))
            if (count === 2) break
        }
        pathCounts.set(version, count)
    }
    return pathCounts
}

function uniquePath(
    graph: DiffGraph,
    fromVersion: string,
    targetVersion: string,
): ReadonlyArray<DiffCatalogEdge> {
    const pathCounts = countPathsToTarget(graph, targetVersion)
    const pathCount = pathCounts.get(fromVersion) ?? 0
    if (pathCount === 0) {
        throw new CdnPlannerError(
            "NO_UPDATE_PATH",
            `no update path from ${fromVersion} to ${targetVersion}`,
        )
    }
    if (pathCount > 1) {
        throw new CdnPlannerError(
            "AMBIGUOUS_UPDATE_PATH",
            `multiple update paths from ${fromVersion} to ${targetVersion}`,
        )
    }

    const path: DiffCatalogEdge[] = []
    let version = fromVersion
    while (version !== targetVersion) {
        const candidates = (graph.adjacency.get(version) ?? [])
            .filter(edge => (pathCounts.get(edge.toVersion) ?? 0) > 0)
        if (candidates.length !== 1) {
            throw new CdnPlannerError("INVALID_CATALOG", "unique update path cannot be reconstructed")
        }
        const edge = candidates[0]
        path.push(edge)
        version = edge.toVersion
    }
    return path
}

function asNonEmptyPath(
    path: ReadonlyArray<DiffCatalogEdge>,
): ReadonlyNonEmptyArray<DiffCatalogEdge> | null {
    return path.length === 0
        ? null
        : path as ReadonlyNonEmptyArray<DiffCatalogEdge>
}

function requireFullEdge(
    edges: ReadonlyArray<CatalogEdge>,
    fullBaseVersion: string,
): FullCatalogEdge {
    const fullEdges = edges.filter((edge): edge is FullCatalogEdge => edge.fromVersion === null)
    if (fullEdges.length !== 1) {
        throw new CdnPlannerError(
            "INVALID_CATALOG",
            `fulfill scope must contain exactly one full edge, found ${fullEdges.length}`,
        )
    }

    const full = fullEdges[0]
    if (full.toVersion !== fullBaseVersion) {
        throw new CdnPlannerError(
            "INVALID_CATALOG",
            `full edge targets ${full.toVersion}, expected ${fullBaseVersion}`,
        )
    }
    return full
}

export function planCdnUpdate(catalog: CdnCatalog, request: PlanRequest): UpdatePlan {
    if ((request as { platform?: unknown }).platform !== "android") {
        throw new CdnPlannerError("UNSUPPORTED_PLATFORM", "only android is supported")
    }
    const assetSizeKind = (request as { assetSizeKind?: unknown }).assetSizeKind
    if (assetSizeKind !== "shortened" && assetSizeKind !== "fulfill") {
        throw new CdnPlannerError(
            "UNSUPPORTED_ASSET_SIZE_KIND",
            "asset size kind must be shortened or fulfill",
        )
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
    const full = requireFullEdge(scopedEdges, catalog.fullBaseVersion)
    const scopedDiffs = scopedEdges.filter((candidate): candidate is DiffCatalogEdge => (
        candidate.fromVersion !== null
    ))
    const diffGraph = buildDiffGraph(scopedDiffs)
    if (!request.isInitial) {
        const knownVersions = new Set<string>([catalog.fullBaseVersion])
        for (const edge of scopedDiffs) {
            knownVersions.add(edge.fromVersion)
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
        const diff = uniquePath(diffGraph, catalog.fullBaseVersion, request.targetVersion)
        const initialDiff = asNonEmptyPath(diff)
        return {
            kind: "initial" as const,
            full,
            diff: initialDiff,
            downloadBytes: archiveBytes([full, ...diff]),
            delayedAssetsBytes: 0 as const,
        }
    }

    const diff = uniquePath(diffGraph, request.currentVersion as string, request.targetVersion)
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
