"use strict"

const fs = require("node:fs")
const path = require("node:path")

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
]

function requireExactObject(value, keys, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`)
    }
    const actualKeys = Object.keys(value).sort()
    const expectedKeys = [...keys].sort()
    if (actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`${label} contains missing or unknown fields`)
    }
    return value
}

function requireFixed(value, expected, label) {
    if (value !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}`)
    return value
}

function requireNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`)
    }
    return value
}

function requireValidSchemaRange(minimum, current) {
    if (minimum > current) {
        throw new Error("minimumDataSchema must not exceed currentDataSchema")
    }
}

function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value)) deepFreeze(nested)
    return Object.freeze(value)
}

function requireRelativePath(value, label) {
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

function requireVersion(value, label) {
    if (typeof value !== "string"
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${label} must be a three-part numeric version`)
    }
    return value
}

function requirePort(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${label} must be a TCP port from 1 through 65535`)
    }
    return value
}

function parseServerReleaseContract(value) {
    const contract = requireExactObject(value, CONTRACT_KEYS, "server_release_contract.json")
    requireFixed(contract.serverManifestSchemaVersion, 3, "serverManifestSchemaVersion")
    requireFixed(contract.runtimeApiVersion, 1, "runtimeApiVersion")
    requireNonNegativeInteger(contract.minimumDataSchema, "minimumDataSchema")
    requireNonNegativeInteger(contract.currentDataSchema, "currentDataSchema")
    requireValidSchemaRange(contract.minimumDataSchema, contract.currentDataSchema)
    requireRelativePath(contract.serverEntry, "serverEntry")
    requireRelativePath(contract.localPrepareEntry, "localPrepareEntry")
    requireRelativePath(contract.adminPath, "adminPath")
    requireFixed(contract.adminRequired, true, "adminRequired")
    requireVersion(contract.bundledCdnCatalogVersion, "bundledCdnCatalogVersion")
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
    return deepFreeze(contract)
}

function loadServerReleaseContract(projectRoot) {
    const filePath = path.join(path.resolve(projectRoot), "assets/server_release_contract.json")
    return parseServerReleaseContract(JSON.parse(fs.readFileSync(filePath, "utf8")))
}

module.exports = { loadServerReleaseContract }
