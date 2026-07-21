import type {
    ArchiveLayer,
    CdnCatalog,
    CdnPlatform,
    DiffCatalogEdge,
    FullCatalogEdge,
    UpdatePlan,
} from "./types"

export type AuditAssetSizeKind = "shortened" | "fulfill" | "delayed"

export type CdnAuditErrorCode =
    | "AUDIT_INTEGER_OVERFLOW"
    | "AUDIT_INVALID_SUMMARY_INPUT"

export class CdnAuditError extends Error {
    readonly code: CdnAuditErrorCode

    constructor(code: CdnAuditErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "CdnAuditError"
        this.code = code
    }
}

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

function requireSummaryInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new CdnAuditError(
            "AUDIT_INVALID_SUMMARY_INPUT",
            `${field} must be a non-negative safe integer`,
        )
    }
    return value
}

function checkedAdd(total: number, value: number, field: string): number {
    requireSummaryInteger(total, field)
    requireSummaryInteger(value, field)
    const result = total + value
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new CdnAuditError(
            "AUDIT_INTEGER_OVERFLOW",
            `${field} exceeds the safe integer range`,
        )
    }
    return result
}

function summarizeArchives(
    archives: ReadonlyArray<{ readonly compressedBytes: number }>,
    field: string,
): ArchiveSummary {
    let archiveCount = 0
    let bytes = 0
    for (const archive of archives) {
        archiveCount = checkedAdd(archiveCount, 1, `${field}.archiveCount`)
        bytes = checkedAdd(bytes, archive.compressedBytes, `${field}.bytes`)
    }
    return { archiveCount, bytes }
}

function summarizeFull(edge: FullCatalogEdge | null): FullSummary | null {
    if (edge === null) return null
    const summary = summarizeArchives(edge.archives, "plan.full")
    return {
        version: edge.toVersion,
        ...summary,
    }
}

function summarizeDiff(edges: ReadonlyArray<DiffCatalogEdge> | null): ReadonlyArray<DiffSummary> | null {
    if (edges === null) return null
    return edges.map((edge, index) => {
        const summary = summarizeArchives(edge.archives, `plan.diff[${index}]`)
        return {
            fromVersion: edge.fromVersion,
            toVersion: edge.toVersion,
            ...summary,
        }
    })
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
    let edgeCount = 0
    let diffEdgeCount = 0
    let archiveCount = 0
    let archiveCompressedBytes = 0
    for (const edge of scopedEdges) {
        edgeCount = checkedAdd(edgeCount, 1, "catalog.edgeCount")
        if (edge.fromVersion !== null) {
            diffEdgeCount = checkedAdd(diffEdgeCount, 1, "catalog.diffEdgeCount")
        }
        for (const archive of edge.archives) {
            const previous = layerSummaries[archive.layer]
            layerSummaries[archive.layer] = {
                archiveCount: checkedAdd(
                    previous.archiveCount,
                    1,
                    `catalog.layers.${archive.layer}.archiveCount`,
                ),
                bytes: checkedAdd(
                    previous.bytes,
                    archive.compressedBytes,
                    `catalog.layers.${archive.layer}.bytes`,
                ),
            }
            archiveCount = checkedAdd(archiveCount, 1, "catalog.archiveCount")
            archiveCompressedBytes = checkedAdd(
                archiveCompressedBytes,
                archive.compressedBytes,
                "catalog.archiveCompressedBytes",
            )
        }
    }

    const installedBytes = requireSummaryInteger(catalog.installedBytes, "catalog.installedBytes")
    const downloadBytes = requireSummaryInteger(plan.downloadBytes, "plan.downloadBytes")
    const delayedAssetsBytes = requireSummaryInteger(
        plan.delayedAssetsBytes,
        "plan.delayedAssetsBytes",
    )

    return {
        schemaVersion: 1,
        auditVersion: 1,
        catalog: {
            fullBaseVersion: catalog.fullBaseVersion,
            targetVersion: catalog.targetVersion,
            installedBytes,
            edgeCount,
            diffEdgeCount,
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
            downloadBytes,
            delayedAssetsBytes: delayedAssetsBytes as 0,
        },
    }
}
