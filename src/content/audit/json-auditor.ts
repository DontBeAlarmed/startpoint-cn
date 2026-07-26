import * as fs from "node:fs"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { ContentAssetAuditSourcePair } from "./types"
import { ContentAssetAuditError } from "./types"

interface JsonAuditRequest {
    readonly sourceRoot: string
    readonly runtimeRoot: string
    readonly pair: ContentAssetAuditSourcePair
}

export interface JsonAuditResult {
    readonly runtimeTable: string
    readonly keyCount: number
}

interface FileIdentity {
    readonly dev: bigint
    readonly ino: bigint
    readonly size: bigint
    readonly mtimeNs: bigint
    readonly ctimeNs: bigint
}

function identity(stat: fs.BigIntStats): FileIdentity {
    return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
    }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
}

export function readStableJsonTable(
    filePath: string,
    missingCode: "CONTENT_ASSET_AUDIT_SOURCE_MISSING" | "CONTENT_ASSET_AUDIT_RUNTIME_MISSING",
    tableName: string,
    inputSide: "source" | "runtime",
): unknown {
    const unreadableCode = inputSide === "source"
        ? "CONTENT_ASSET_AUDIT_SOURCE_UNREADABLE"
        : "CONTENT_ASSET_AUDIT_RUNTIME_UNREADABLE"
    let descriptor: number | null = null
    let bytes: Buffer
    try {
        const pathBefore = fs.lstatSync(filePath, { bigint: true })
        if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
            throw new ContentAssetAuditError(
                unreadableCode,
                `table is not a regular file: ${tableName}`,
                tableName,
                inputSide,
            )
        }
        descriptor = fs.openSync(
            filePath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        )
        const descriptorBefore = fs.fstatSync(descriptor, { bigint: true })
        if (!descriptorBefore.isFile()
            || !sameIdentity(identity(pathBefore), identity(descriptorBefore))) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_SOURCE_CHANGED",
                `table changed before it was read: ${tableName}`,
                tableName,
                inputSide,
            )
        }
        const before = identity(descriptorBefore)
        bytes = fs.readFileSync(descriptor)
        const descriptorAfter = identity(fs.fstatSync(descriptor, { bigint: true }))
        const pathAfter = identity(fs.lstatSync(filePath, { bigint: true }))
        if (!sameIdentity(before, descriptorAfter) || !sameIdentity(before, pathAfter)) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_SOURCE_CHANGED",
                `table changed while it was being read: ${tableName}`,
                tableName,
                inputSide,
            )
        }
    } catch (error) {
        if (error instanceof ContentAssetAuditError) throw error
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new ContentAssetAuditError(
                missingCode,
                `table file is missing: ${tableName}`,
                tableName,
                inputSide,
            )
        }
        throw new ContentAssetAuditError(
            unreadableCode,
            `table file is not readable: ${tableName}`,
            tableName,
            inputSide,
        )
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor)
    }

    try {
        return JSON.parse(bytes.toString("utf8"))
    } catch {
        throw new ContentAssetAuditError(
            "CONTENT_ASSET_AUDIT_JSON_INVALID",
            `table is not valid JSON: ${tableName}`,
            tableName,
            inputSide,
        )
    }
}

function sortedKeys(value: unknown): string[] {
    return value !== null && typeof value === "object"
        ? Object.keys(value).sort()
        : []
}

function compareJsonValues(
    source: unknown,
    runtime: unknown,
    runtimeTable: string,
): JsonAuditResult {
    const sourceKeys = sortedKeys(source)
    const runtimeKeys = sortedKeys(runtime)
    if (!isDeepStrictEqual(sourceKeys, runtimeKeys)) {
        throw new ContentAssetAuditError(
            "CONTENT_ASSET_AUDIT_KEY_MISMATCH",
            `top-level key set differs: ${runtimeTable}`,
            runtimeTable,
        )
    }
    if (!isDeepStrictEqual(source, runtime)) {
        throw new ContentAssetAuditError(
            "CONTENT_ASSET_AUDIT_CONTENT_MISMATCH",
            `table content differs: ${runtimeTable}`,
            runtimeTable,
        )
    }
    return { runtimeTable, keyCount: sourceKeys.length }
}

export function auditJsonSourceValue(request: {
    readonly sourceRoot: string
    readonly pair: ContentAssetAuditSourcePair
    readonly runtimeValue: unknown
}): JsonAuditResult {
    const source = readStableJsonTable(
        path.join(request.sourceRoot, request.pair.sourceRelativePath),
        "CONTENT_ASSET_AUDIT_SOURCE_MISSING",
        request.pair.runtimeTable,
        "source",
    )
    return compareJsonValues(source, request.runtimeValue, request.pair.runtimeTable)
}

export function auditJsonSourcePair(request: JsonAuditRequest): JsonAuditResult {
    const source = readStableJsonTable(
        path.join(request.sourceRoot, request.pair.sourceRelativePath),
        "CONTENT_ASSET_AUDIT_SOURCE_MISSING",
        request.pair.runtimeTable,
        "source",
    )
    const runtime = readStableJsonTable(
        path.join(request.runtimeRoot, request.pair.runtimeTable),
        "CONTENT_ASSET_AUDIT_RUNTIME_MISSING",
        request.pair.runtimeTable,
        "runtime",
    )
    return compareJsonValues(source, runtime, request.pair.runtimeTable)
}
