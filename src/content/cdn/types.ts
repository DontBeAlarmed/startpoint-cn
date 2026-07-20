export type CdnPlatform = "android"

export type AssetSizeKind = "shortened" | "fulfill"

export type ArchiveLayer = "common" | "quality" | "platform"

export interface CatalogArchive {
    relativePath: string
    compressedBytes: number
    sha256: string
    layer: ArchiveLayer
    order: number
}

export interface CatalogEdge {
    fromVersion: string | null
    toVersion: string
    platform: CdnPlatform
    assetSizeKind: AssetSizeKind
    archives: CatalogArchive[]
}

export interface CdnCatalog {
    schemaVersion: 1
    edges: CatalogEdge[]
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
    code: CatalogValidationIssueCode
    message: string
    edgeIndex?: number
    archiveIndex?: number
    relativePath?: string
}

export interface PlanRequest {
    currentVersion: string | null
    targetVersion: string
    platform: CdnPlatform
    assetSizeKind: AssetSizeKind
    isInitial: boolean
}

export interface UpdatePlan {
    full: CatalogEdge | null
    diff: CatalogEdge[] | null
    downloadBytes: number
}
