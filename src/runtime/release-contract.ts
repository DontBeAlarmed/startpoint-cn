import fs from "node:fs"
import path from "node:path"

const CONTRACT_KEYS = [
    "adminPath",
    "adminRequired",
    "bundledCdnCatalogVersion",
    "currentDataSchema",
    "defaultPorts",
    "localPrepareEntry",
    "minimumDataSchema",
    "runtimeApiVersion",
    "serverEntry",
    "serverManifestSchemaVersion",
    "supportedAssetModes",
] as const

export interface ServerReleaseContract {
    readonly serverManifestSchemaVersion: 3
    readonly runtimeApiVersion: 1
    readonly minimumDataSchema: number
    readonly currentDataSchema: number
    readonly serverEntry: "out/cn-server.js"
    readonly localPrepareEntry: "out/content/sync/entry.js"
    readonly adminPath: "web/dist"
    readonly adminRequired: true
    readonly bundledCdnCatalogVersion: "1.4.54"
    readonly supportedAssetModes: readonly ["client-owned", "local", "remote"]
    readonly defaultPorts: Readonly<{ http: number; tcp: number; hub: number }>
}

function requireExactObject(
    value: unknown,
    keys: readonly string[],
    label: string,
): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`)
    }
    const actualKeys = Object.keys(value).sort()
    const expectedKeys = [...keys].sort()
    if (actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`${label} contains missing or unknown fields`)
    }
    return value as Record<string, unknown>
}

function requireFixed<T>(value: unknown, expected: T, label: string): T {
    if (value !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}`)
    return value as T
}

function requireNonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative safe integer`)
    }
    return value as number
}

function requireValidSchemaRange(minimum: number, current: number): void {
    if (minimum > current) {
        throw new Error("minimumDataSchema must not exceed currentDataSchema")
    }
}

function requireRelativePath(value: unknown, label: string): string {
    if (typeof value !== "string"
        || value.length === 0
        || value.includes("\\")
        || path.posix.isAbsolute(value)
        || path.posix.normalize(value) !== value
        || value === ".."
        || value.startsWith("../")) {
        throw new Error(`${label} must be a normalized relative path`)
    }
    return value
}

function requireVersion(value: unknown, label: string): string {
    if (typeof value !== "string"
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${label} must be a three-part numeric version`)
    }
    return value
}

function requirePort(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
        throw new Error(`${label} must be a TCP port from 1 through 65535`)
    }
    return value as number
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    return Object.freeze(value)
}

export function parseServerReleaseContract(value: unknown): ServerReleaseContract {
    const contract = requireExactObject(value, CONTRACT_KEYS, "server_release_contract.json")
    requireFixed(contract.serverManifestSchemaVersion, 3, "serverManifestSchemaVersion")
    requireFixed(contract.runtimeApiVersion, 1, "runtimeApiVersion")
    requireNonNegativeInteger(contract.minimumDataSchema, "minimumDataSchema")
    requireNonNegativeInteger(contract.currentDataSchema, "currentDataSchema")
    requireValidSchemaRange(
        requireNonNegativeInteger(contract.minimumDataSchema, "minimumDataSchema"),
        requireNonNegativeInteger(contract.currentDataSchema, "currentDataSchema"),
    )
    requireFixed(requireRelativePath(contract.serverEntry, "serverEntry"), "out/cn-server.js", "serverEntry")
    requireFixed(requireRelativePath(contract.localPrepareEntry, "localPrepareEntry"), "out/content/sync/entry.js", "localPrepareEntry")
    requireFixed(requireRelativePath(contract.adminPath, "adminPath"), "web/dist", "adminPath")
    requireFixed(contract.adminRequired, true, "adminRequired")
    requireFixed(requireVersion(contract.bundledCdnCatalogVersion, "bundledCdnCatalogVersion"), "1.4.54", "bundledCdnCatalogVersion")
    if (!Array.isArray(contract.supportedAssetModes)
        || contract.supportedAssetModes.length !== 3
        || contract.supportedAssetModes[0] !== "client-owned"
        || contract.supportedAssetModes[1] !== "local"
        || contract.supportedAssetModes[2] !== "remote") {
        throw new Error("supportedAssetModes must be client-owned, local, remote in order")
    }
    const ports = requireExactObject(contract.defaultPorts, ["hub", "http", "tcp"], "defaultPorts")
    requirePort(ports.http, "defaultPorts.http")
    requirePort(ports.tcp, "defaultPorts.tcp")
    requirePort(ports.hub, "defaultPorts.hub")
    return deepFreeze(contract as unknown as ServerReleaseContract)
}

export function loadServerReleaseContract(projectRoot: string): Readonly<ServerReleaseContract> {
    const filePath = path.join(path.resolve(projectRoot), "assets/server_release_contract.json")
    return parseServerReleaseContract(JSON.parse(fs.readFileSync(filePath, "utf8")))
}

export const SERVER_RELEASE_CONTRACT = loadServerReleaseContract(path.resolve(__dirname, "../.."))
export const CURRENT_DATA_SCHEMA = SERVER_RELEASE_CONTRACT.currentDataSchema
export const RUNTIME_API_VERSION = SERVER_RELEASE_CONTRACT.runtimeApiVersion
export const BUNDLED_CDN_CATALOG_VERSION = SERVER_RELEASE_CONTRACT.bundledCdnCatalogVersion
export const DEFAULT_SERVER_PORTS = SERVER_RELEASE_CONTRACT.defaultPorts
export const SUPPORTED_ASSET_MODES = SERVER_RELEASE_CONTRACT.supportedAssetModes
