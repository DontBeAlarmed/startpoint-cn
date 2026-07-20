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

export interface CatalogEdge {
    readonly fromVersion: string | null
    readonly toVersion: string
    readonly platform: CdnPlatform
    readonly assetSizeKind: AssetSizeKind
    readonly archives: ReadonlyArray<CatalogArchive>
}

export interface CdnCatalog {
    readonly schemaVersion: 1
    readonly edges: ReadonlyArray<CatalogEdge>
}

export type CatalogValidationIssueCode =
    | "UNSUPPORTED_PLATFORM"
    | "INVALID_VERSION"
    | "INVALID_ARCHIVE_PATH"
    | "INVALID_COMPRESSED_BYTES"
    | "INVALID_SHA256"
    | "INVALID_ARCHIVE_ORDER"
    | "DUPLICATE_ARCHIVE_ORDER"
    | "DUPLICATE_EDGE"
    | "CONFLICTING_EDGE"
    | "GRAPH_CYCLE"
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
    readonly full: CatalogEdge
    readonly diff: ReadonlyNonEmptyArray<CatalogEdge> | null
}

export interface IncrementalUpdatePlan extends UpdatePlanBase {
    readonly kind: "incremental"
    readonly full: null
    readonly diff: ReadonlyNonEmptyArray<CatalogEdge>
}

export type UpdatePlan = UpToDateUpdatePlan | InitialUpdatePlan | IncrementalUpdatePlan
