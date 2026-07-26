export type ContentAssetAuditErrorCode =
    | "CONTENT_ASSET_AUDIT_REGISTRY_DUPLICATE"
    | "CONTENT_ASSET_AUDIT_REGISTRY_PATH"
    | "CONTENT_ASSET_AUDIT_SOURCE_MISSING"
    | "CONTENT_ASSET_AUDIT_SOURCE_UNREADABLE"
    | "CONTENT_ASSET_AUDIT_SOURCE_VERSION"
    | "CONTENT_ASSET_AUDIT_RUNTIME_MISSING"
    | "CONTENT_ASSET_AUDIT_RUNTIME_UNREADABLE"
    | "CONTENT_ASSET_AUDIT_JSON_INVALID"
    | "CONTENT_ASSET_AUDIT_SOURCE_CHANGED"
    | "CONTENT_ASSET_AUDIT_KEY_MISMATCH"
    | "CONTENT_ASSET_AUDIT_CONTENT_MISMATCH"
    | "CONTENT_ASSET_AUDIT_MISSION_CONTRACT"
    | "CONTENT_ASSET_AUDIT_ARGUMENTS"

export class ContentAssetAuditError extends Error {
    readonly code: ContentAssetAuditErrorCode
    readonly tableName: string | null
    readonly inputSide: "source" | "runtime" | null

    constructor(
        code: ContentAssetAuditErrorCode,
        message: string,
        tableName: string | null = null,
        inputSide: "source" | "runtime" | null = null,
    ) {
        super(`${code}: ${message}`)
        this.name = "ContentAssetAuditError"
        this.code = code
        this.tableName = tableName
        this.inputSide = inputSide
    }
}

export interface ContentAssetAuditSourcePair {
    readonly sourceRelativePath: string
    readonly runtimeTable: string
}
