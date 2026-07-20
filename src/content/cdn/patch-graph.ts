import type {
    AssetSizeKind,
    CatalogEdge,
    CatalogValidationIssue,
    CdnPlatform,
} from "./types"

function scopeKey(platform: CdnPlatform, assetSizeKind: AssetSizeKind): string {
    return `${platform}\u0000${assetSizeKind}`
}

function outgoingKey(edge: CatalogEdge): string {
    return `${scopeKey(edge.platform, edge.assetSizeKind)}\u0000${edge.fromVersion ?? "<full>"}`
}

function exactEdgeKey(edge: CatalogEdge): string {
    return `${outgoingKey(edge)}\u0000${edge.toVersion}`
}

function edgeArchiveMetadataKey(edge: CatalogEdge): string {
    return JSON.stringify([...edge.archives]
        .map(archive => [
            archive.relativePath,
            archive.compressedBytes,
            archive.sha256,
            archive.layer,
            archive.order,
        ])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

function issue(
    code: CatalogValidationIssue["code"],
    message: string,
    edgeIndex?: number,
): CatalogValidationIssue {
    return { code, message, ...(edgeIndex === undefined ? {} : { edgeIndex }) }
}

function findCycleIssues(
    edges: ReadonlyArray<CatalogEdge>,
    issues: CatalogValidationIssue[],
): void {
    const byScope = new Map<string, Array<readonly [number, CatalogEdge]>>()
    edges.forEach((edge, edgeIndex) => {
        if (edge.fromVersion === null) return
        const key = scopeKey(edge.platform, edge.assetSizeKind)
        const scoped = byScope.get(key) ?? []
        scoped.push([edgeIndex, edge])
        byScope.set(key, scoped)
    })

    for (const scopedEdges of byScope.values()) {
        const adjacency = new Map<string, Array<readonly [string, number]>>()
        for (const [edgeIndex, edge] of scopedEdges) {
            const outgoing = adjacency.get(edge.fromVersion as string) ?? []
            outgoing.push([edge.toVersion, edgeIndex])
            adjacency.set(edge.fromVersion as string, outgoing)
        }

        const visiting = new Set<string>()
        const visited = new Set<string>()
        const reportedEdges = new Set<number>()

        const visit = (version: string): void => {
            if (visited.has(version)) return
            visiting.add(version)
            for (const [nextVersion, edgeIndex] of adjacency.get(version) ?? []) {
                if (visiting.has(nextVersion)) {
                    if (!reportedEdges.has(edgeIndex)) {
                        issues.push(issue(
                            "GRAPH_CYCLE",
                            `patch graph cycle reaches ${nextVersion}`,
                            edgeIndex,
                        ))
                        reportedEdges.add(edgeIndex)
                    }
                    continue
                }
                visit(nextVersion)
            }
            visiting.delete(version)
            visited.add(version)
        }

        for (const version of adjacency.keys()) visit(version)
    }
}

function findReachabilityIssues(
    edges: ReadonlyArray<CatalogEdge>,
    fullBaseVersion: string,
    issues: CatalogValidationIssue[],
): void {
    const scopes = new Set(edges.map(edge => scopeKey(edge.platform, edge.assetSizeKind)))

    for (const scope of scopes) {
        const scopedEdges = edges
            .map((edge, edgeIndex) => [edgeIndex, edge] as const)
            .filter(([, edge]) => scopeKey(edge.platform, edge.assetSizeKind) === scope)
        const fullEdges = scopedEdges.filter(([, edge]) => edge.fromVersion === null)
        if (!fullEdges.some(([, edge]) => edge.toVersion === fullBaseVersion)) {
            issues.push(issue("MISSING_PATH", `missing full edge for base ${fullBaseVersion}`))
        }

        const reachable = new Set<string>([fullBaseVersion])
        let changed = true
        while (changed) {
            changed = false
            for (const [, edge] of scopedEdges) {
                if (edge.fromVersion !== null
                    && reachable.has(edge.fromVersion)
                    && !reachable.has(edge.toVersion)) {
                    reachable.add(edge.toVersion)
                    changed = true
                }
            }
        }

        for (const [edgeIndex, edge] of scopedEdges) {
            if (edge.fromVersion !== null && !reachable.has(edge.fromVersion)) {
                issues.push(issue(
                    "MISSING_PATH",
                    `diff edge ${edge.fromVersion} -> ${edge.toVersion} is not reachable from full base ${fullBaseVersion}`,
                    edgeIndex,
                ))
            }
        }
    }
}

export function validatePatchGraph(
    edges: ReadonlyArray<CatalogEdge>,
    fullBaseVersion: string,
): ReadonlyArray<CatalogValidationIssue> {
    const issues: CatalogValidationIssue[] = []
    const exactEdges = new Map<string, readonly [number, string]>()
    const outgoing = new Map<string, readonly [string, number]>()

    edges.forEach((edge, edgeIndex) => {
        const exactKey = exactEdgeKey(edge)
        const existingExactEdge = exactEdges.get(exactKey)
        if (existingExactEdge !== undefined) {
            const metadataMatches = existingExactEdge[1] === edgeArchiveMetadataKey(edge)
            issues.push(issue(
                metadataMatches ? "DUPLICATE_EDGE" : "CONFLICTING_EDGE",
                `edge ${metadataMatches ? "duplicates" : "conflicts with"} edge ${existingExactEdge[0]}`,
                edgeIndex,
            ))
        } else {
            exactEdges.set(exactKey, [edgeIndex, edgeArchiveMetadataKey(edge)])
        }

        const fromKey = outgoingKey(edge)
        const existing = outgoing.get(fromKey)
        if (existing && existing[0] !== edge.toVersion) {
            const label = edge.fromVersion === null ? "full base" : edge.fromVersion
            issues.push(issue(
                edge.fromVersion === null ? "CONFLICTING_EDGE" : "GRAPH_FORK",
                `${label} points to both ${existing[0]} and ${edge.toVersion}`,
                edgeIndex,
            ))
            issues.push(issue(
                "CONFLICTING_EDGE",
                `edge conflicts with edge ${existing[1]}`,
                edgeIndex,
            ))
        } else if (!existing) {
            outgoing.set(fromKey, [edge.toVersion, edgeIndex])
        }
    })

    findCycleIssues(edges, issues)
    findReachabilityIssues(edges, fullBaseVersion, issues)
    return issues
}
