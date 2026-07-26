import * as fs from "node:fs"
import * as path from "node:path"
import { TABLE_SOURCES } from "../sync/table-registry"
import { auditJsonSourceValue, readStableJsonTable } from "./json-auditor"
import {
    auditMissionTableContracts,
    type MissionContractAuditResult,
} from "./mission-contracts"
import { ASSET_AUDIT_SOURCE_PAIRS } from "./source-registry"
import {
    ContentAssetAuditError,
    type ContentAssetAuditSourcePair,
} from "./types"

export interface ContentAssetAuditRequest {
    readonly sourceRoot: string
    readonly runtimeRoot: string
}

export interface ContentAssetAuditReport {
    readonly schemaVersion: 1
    readonly sourceVersion: string
    readonly registryTableCount: number
    readonly readableRuntimeTableCount: number
    readonly deepComparedTableCount: number
    readonly deepComparedKeyCount: number
    readonly missionContracts: MissionContractAuditResult
}

export const SUPPORTED_CONTENT_ASSET_AUDIT_VERSION = "1.4.54"

interface ContentAssetAuditDependencies {
    readonly tableNames?: readonly string[]
    readonly sourcePairs?: readonly ContentAssetAuditSourcePair[]
    readonly auditMissionContracts?: (
        tables: Readonly<Record<string, unknown>>,
    ) => MissionContractAuditResult
}

function defaultTableNames(): readonly string[] {
    return TABLE_SOURCES.map(definition => definition.tableName)
}

function resolveSourceLayout(sourceRoot: string): {
    readonly orderedMapRoot: string
    readonly versionPath: string
} {
    const orderedMapCandidate = path.join(sourceRoot, "orderedmap")
    if (fs.existsSync(orderedMapCandidate)) {
        return { orderedMapRoot: orderedMapCandidate, versionPath: path.join(sourceRoot, "VERSION") }
    }
    const localVersion = path.join(sourceRoot, "VERSION")
    return {
        orderedMapRoot: sourceRoot,
        versionPath: fs.existsSync(localVersion) ? localVersion : path.join(path.dirname(sourceRoot), "VERSION"),
    }
}

function readSourceVersion(versionPath: string): string {
    try {
        const version = fs.readFileSync(versionPath, "utf8").trim()
        if (version.length === 0) throw new Error("empty version")
        if (version !== SUPPORTED_CONTENT_ASSET_AUDIT_VERSION) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_SOURCE_VERSION",
                `source VERSION must be ${SUPPORTED_CONTENT_ASSET_AUDIT_VERSION}`,
                "VERSION",
                "source",
            )
        }
        return version
    } catch (error) {
        if (error instanceof ContentAssetAuditError) throw error
        throw new ContentAssetAuditError(
            "CONTENT_ASSET_AUDIT_SOURCE_MISSING",
            "source VERSION is missing or empty",
            "VERSION",
            "source",
        )
    }
}

function readRuntimeTables(runtimeRoot: string, tableNames: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(tableNames.map(tableName => [
        tableName,
        readStableJsonTable(
            path.join(runtimeRoot, tableName),
            "CONTENT_ASSET_AUDIT_RUNTIME_MISSING",
            tableName,
            "runtime",
        ),
    ]))
}

export function auditRuntimeRegistryTables(
    runtimeRoot: string,
    tableNames: readonly string[] = defaultTableNames(),
): { readonly registryTableCount: number; readonly readableRuntimeTableCount: number } {
    const tables = readRuntimeTables(runtimeRoot, tableNames)
    return {
        registryTableCount: tableNames.length,
        readableRuntimeTableCount: Object.keys(tables).length,
    }
}

export function runContentAssetAudit(
    request: ContentAssetAuditRequest,
    dependencies: ContentAssetAuditDependencies = {},
): ContentAssetAuditReport {
    const tableNames = dependencies.tableNames ?? defaultTableNames()
    const sourcePairs = dependencies.sourcePairs ?? ASSET_AUDIT_SOURCE_PAIRS
    const missionAuditor = dependencies.auditMissionContracts ?? auditMissionTableContracts
    const source = resolveSourceLayout(request.sourceRoot)
    const sourceVersion = readSourceVersion(source.versionPath)
    const runtimeTables = readRuntimeTables(request.runtimeRoot, tableNames)

    let deepComparedKeyCount = 0
    for (const pair of sourcePairs) {
        if (!Object.prototype.hasOwnProperty.call(runtimeTables, pair.runtimeTable)) {
            throw new ContentAssetAuditError(
                "CONTENT_ASSET_AUDIT_RUNTIME_MISSING",
                `registered runtime table is missing: ${pair.runtimeTable}`,
                pair.runtimeTable,
                "runtime",
            )
        }
        deepComparedKeyCount += auditJsonSourceValue({
            sourceRoot: source.orderedMapRoot,
            pair,
            runtimeValue: runtimeTables[pair.runtimeTable],
        }).keyCount
    }
    return {
        schemaVersion: 1,
        sourceVersion,
        registryTableCount: tableNames.length,
        readableRuntimeTableCount: Object.keys(runtimeTables).length,
        deepComparedTableCount: sourcePairs.length,
        deepComparedKeyCount,
        missionContracts: missionAuditor(runtimeTables),
    }
}
