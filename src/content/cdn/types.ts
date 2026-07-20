export type ReadonlyNonEmptyArray<T> = readonly [T, ...T[]]

export type CdnPlatform = "android"

export type AssetSizeKind = "shortened" | "fulfill"

export type ArchiveLayer = "common" | "quality" | "platform"

export interface CatalogArchive {
    readonly relativePath: string
    readonly compressedBytes: number
    readonly sha256: string
    readonly layer: ArchiveLayer
    readonly order: number
}

interface CatalogEdgeBase {
    readonly toVersion: string
    readonly platform: CdnPlatform
    readonly assetSizeKind: AssetSizeKind
    readonly archives: ReadonlyArray<CatalogArchive>
}

export interface FullCatalogEdge extends CatalogEdgeBase {
    readonly fromVersion: null
}

export interface DiffCatalogEdge extends CatalogEdgeBase {
    readonly fromVersion: string
}

export type CatalogEdge = FullCatalogEdge | DiffCatalogEdge

export interface CdnCatalog {
    readonly schemaVersion: 1
    readonly fullBaseVersion: string
    readonly targetVersion: string
    readonly installedBytes: number
    readonly entityListsRelativePath: string
    readonly edges: ReadonlyArray<CatalogEdge>
}

export type CatalogArchiveKind = "full" | "diff"

export interface CdnCatalogArchiveInput {
    readonly kind: CatalogArchiveKind
    readonly fromVersion: string | null
    readonly toVersion: string
    readonly platform: CdnPlatform
    readonly layer: ArchiveLayer
    readonly order: number
    readonly relativePath: string
    readonly compressedBytes: number
    readonly sha256: string
}

export interface CdnCatalogInput {
    readonly archives: ReadonlyArray<CdnCatalogArchiveInput>
    readonly installedBytes: number
    readonly entityListsRelativePath: string
}

export type CatalogValidationIssueCode =
    | "UNSUPPORTED_PLATFORM"
    | "INVALID_VERSION"
    | "INVALID_ARCHIVE_PATH"
    | "INVALID_COMPRESSED_BYTES"
    | "INVALID_SHA256"
    | "INVALID_ARCHIVE_ORDER"
    | "INVALID_INSTALLED_BYTES"
    | "DUPLICATE_ARCHIVE_ORDER"
    | "NON_CONTIGUOUS_ARCHIVE_ORDER"
    | "UNSTABLE_ARCHIVE_SNAPSHOT"
    | "DUPLICATE_ARCHIVE_PATH"
    | "CONFLICTING_ARCHIVE_PATH"
    | "DUPLICATE_EDGE"
    | "CONFLICTING_EDGE"
    | "GRAPH_CYCLE"
    | "GRAPH_FORK"
    | "MISSING_ARCHIVE_LAYER"
    | "AMBIGUOUS_PATH"
    | "MISSING_PATH"

export interface CatalogValidationIssue {
    readonly code: CatalogValidationIssueCode
    readonly message: string
    readonly edgeIndex?: number
    readonly archiveIndex?: number
    readonly relativePath?: string
}

export interface PlanRequest {
    readonly currentVersion: string | null
    readonly targetVersion: string
    readonly platform: CdnPlatform
    readonly assetSizeKind: AssetSizeKind
    readonly isInitial: boolean
}

interface UpdatePlanBase {
    readonly downloadBytes: number
}

export interface UpToDateUpdatePlan extends UpdatePlanBase {
    readonly kind: "up-to-date"
    readonly full: null
    readonly diff: null
}

export interface InitialUpdatePlan extends UpdatePlanBase {
    readonly kind: "initial"
    readonly full: FullCatalogEdge
    readonly diff: ReadonlyNonEmptyArray<DiffCatalogEdge> | null
}

export interface IncrementalUpdatePlan extends UpdatePlanBase {
    readonly kind: "incremental"
    readonly full: null
    readonly diff: ReadonlyNonEmptyArray<DiffCatalogEdge>
}

export type UpdatePlan = UpToDateUpdatePlan | InitialUpdatePlan | IncrementalUpdatePlan
