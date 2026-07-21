import type {
    ArchiveLayer,
    CdnCatalog,
    CdnPlatform,
    DiffCatalogEdge,
    FullCatalogEdge,
    UpdatePlan,
} from "./types"

export type AuditAssetSizeKind = "shortened" | "fulfill" | "delayed"

export interface CdnAuditRequest {
    readonly currentVersion: string | null
    readonly targetVersion: string
    readonly platform: CdnPlatform
    readonly requestedAssetSize: AuditAssetSizeKind
    readonly effectiveAssetSize: "fulfill"
    readonly isInitial: boolean
}

interface ArchiveSummary {
    readonly archiveCount: number
    readonly bytes: number
}

interface DiffSummary extends ArchiveSummary {
    readonly fromVersion: string
    readonly toVersion: string
}

interface FullSummary extends ArchiveSummary {
    readonly version: string
}

export interface CdnAuditReport {
    readonly schemaVersion: 1
    readonly auditVersion: 1
    readonly catalog: {
        readonly fullBaseVersion: string
        readonly targetVersion: string
        readonly installedBytes: number
        readonly edgeCount: number
        readonly diffEdgeCount: number
        readonly archiveCount: number
        readonly archiveCompressedBytes: number
        readonly layers: Readonly<Record<ArchiveLayer, ArchiveSummary>>
        readonly entityListsRelativePath: string
    }
    readonly scope: {
        readonly platform: CdnPlatform
        readonly assetSize: AuditAssetSizeKind
        readonly effectiveAssetSize: "fulfill"
    }
    readonly graph: {
        readonly validationIssueCount: 0
        readonly forkCount: 0
        readonly cycleCount: 0
        readonly duplicateCount: 0
        readonly missingPathCount: 0
        readonly missingLayerCount: 0
    }
    readonly plan: {
        readonly kind: UpdatePlan["kind"]
        readonly currentVersion: string | null
        readonly targetVersion: string
        readonly isInitial: boolean
        readonly full: FullSummary | null
        readonly diff: ReadonlyArray<DiffSummary> | null
        readonly downloadBytes: number
        readonly delayedAssetsBytes: 0
    }
}

function sumArchiveBytes(archives: ReadonlyArray<{ readonly compressedBytes: number }>): number {
    return archives.reduce((total, archive) => total + archive.compressedBytes, 0)
}

function summarizeFull(edge: FullCatalogEdge | null): FullSummary | null {
    if (edge === null) return null
    return {
        version: edge.toVersion,
        archiveCount: edge.archives.length,
        bytes: sumArchiveBytes(edge.archives),
    }
}

function summarizeDiff(edges: ReadonlyArray<DiffCatalogEdge> | null): ReadonlyArray<DiffSummary> | null {
    if (edges === null) return null
    return edges.map(edge => ({
        fromVersion: edge.fromVersion,
        toVersion: edge.toVersion,
        archiveCount: edge.archives.length,
        bytes: sumArchiveBytes(edge.archives),
    }))
}

export function createCdnAuditReport(
    catalog: CdnCatalog,
    plan: UpdatePlan,
    request: CdnAuditRequest,
): CdnAuditReport {
    const scopedEdges = catalog.edges.filter(edge => (
        edge.platform === request.platform
        && edge.assetSizeKind === request.effectiveAssetSize
    ))
    const layerSummaries: Record<ArchiveLayer, ArchiveSummary> = {
        common: { archiveCount: 0, bytes: 0 },
        quality: { archiveCount: 0, bytes: 0 },
        platform: { archiveCount: 0, bytes: 0 },
    }
    let archiveCount = 0
    let archiveCompressedBytes = 0
    for (const edge of scopedEdges) {
        archiveCount += edge.archives.length
        for (const archive of edge.archives) {
            archiveCompressedBytes += archive.compressedBytes
            const previous = layerSummaries[archive.layer]
            layerSummaries[archive.layer] = {
                archiveCount: previous.archiveCount + 1,
                bytes: previous.bytes + archive.compressedBytes,
            }
        }
    }

    return {
        schemaVersion: 1,
        auditVersion: 1,
        catalog: {
            fullBaseVersion: catalog.fullBaseVersion,
            targetVersion: catalog.targetVersion,
            installedBytes: catalog.installedBytes,
            edgeCount: scopedEdges.length,
            diffEdgeCount: scopedEdges.filter(edge => edge.fromVersion !== null).length,
            archiveCount,
            archiveCompressedBytes,
            layers: layerSummaries,
            entityListsRelativePath: catalog.entityListsRelativePath,
        },
        scope: {
            platform: request.platform,
            assetSize: request.requestedAssetSize,
            effectiveAssetSize: request.effectiveAssetSize,
        },
        graph: {
            validationIssueCount: 0,
            forkCount: 0,
            cycleCount: 0,
            duplicateCount: 0,
            missingPathCount: 0,
            missingLayerCount: 0,
        },
        plan: {
            kind: plan.kind,
            currentVersion: request.currentVersion,
            targetVersion: request.targetVersion,
            isInitial: request.isInitial,
            full: summarizeFull(plan.full),
            diff: summarizeDiff(plan.diff),
            downloadBytes: plan.downloadBytes,
            delayedAssetsBytes: plan.delayedAssetsBytes,
        },
    }
}
