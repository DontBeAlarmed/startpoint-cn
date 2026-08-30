#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { canonicalJsonBuffer, sha256Hex } = require("./canonical-json.cjs")
const { loadServerReleaseContract } = require("./release-contract.cjs")

const MANIFEST_NAME = "server-manifest.json"
const CONTRACT = loadServerReleaseContract(path.resolve(__dirname, "../.."))
const ROOT_KEYS = ["admin", "assets", "bundleId", "entry", "files", "name", "ports", "requires", "schemaVersion", "serverVersion", "startup"]

function fail(message) {
    throw new Error(message)
}

function compareRelativePaths(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function exactKeys(value, expected, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`${label} must be an object with exact keys`)
    }
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    if (actual.length !== sortedExpected.length
        || actual.some((key, index) => key !== sortedExpected[index])) {
        fail(`${label} must have exact keys`)
    }
}

function safeRelativePath(value, label) {
    if (typeof value !== "string"
        || value.length === 0
        || value.includes("\\")
        || value.includes("\0")
        || path.posix.isAbsolute(value)
        || /^[A-Za-z]:/.test(value)
        || path.posix.normalize(value) !== value
        || value.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
        fail(`${label} is an unsafe POSIX relative path`)
    }
    return value
}

function isWithin(relativePath, root) {
    return relativePath === root || relativePath.startsWith(`${root}/`)
}

function requireOwnedBundlePath(relativePath, directory) {
    if (path.posix.basename(relativePath) === ".gitignore") {
        fail(`bundle path "${relativePath}" is not an allowed owned path`)
    }
    if (!directory && (relativePath === "LICENSE" || relativePath === "NOTICE")) return
    if (isWithin(relativePath, "out") && !isWithin(relativePath, "out/.tsbuildinfo-cn")) return
    if (isWithin(relativePath, "assets")
        && !isWithin(relativePath, "assets/asset-patch")) return
    if (isWithin(relativePath, CONTRACT.adminPath)) return
    if (directory && relativePath === path.posix.dirname(CONTRACT.adminPath)) return
    fail(`bundle path "${relativePath}" is not an allowed owned path`)
}

function readRegularBytes(filePath, label) {
    let status
    try {
        status = fs.lstatSync(filePath)
    } catch {
        fail(`${label} is missing`)
    }
    if (status.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
    if (!status.isFile()) fail(`${label} must be a regular file`)

    let descriptor
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        if (!fs.fstatSync(descriptor).isFile()) fail(`${label} must be a regular file`)
        return fs.readFileSync(descriptor)
    } catch (error) {
        if (error instanceof Error && !error.message.includes(filePath)) throw error
        fail(`${label} could not be read safely`)
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor)
    }
}

function parseNodeRequirement(requirement) {
    if (typeof requirement !== "string") fail("requires.node must use the >=major.minor.patch form")
    const match = requirement.match(/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    if (!match) fail("requires.node must use the >=major.minor.patch form")
    return match.slice(1).map(Number)
}

function compareVersions(left, right) {
    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) return left[index] - right[index]
    }
    return 0
}

function validateManifest(manifest, manifestBytes, dataSchema, dependencyLock) {
    exactKeys(manifest, ROOT_KEYS, "manifest")
    if (!manifestBytes.equals(canonicalJsonBuffer(manifest))) fail("server manifest must be canonical JSON")
    if (manifest.schemaVersion !== CONTRACT.serverManifestSchemaVersion) fail("schemaVersion must be 3")
    if (manifest.name !== "starpoint-cn") fail("name must be starpoint-cn")
    if (typeof manifest.serverVersion !== "string"
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.serverVersion)) {
        fail("serverVersion must be a semantic version")
    }
    if (typeof manifest.bundleId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.bundleId)) {
        fail("bundleId must be a lowercase SHA-256 digest")
    }
    if (safeRelativePath(manifest.entry, "entry") !== CONTRACT.serverEntry) {
        fail(`entry must be ${CONTRACT.serverEntry}`)
    }
    exactKeys(manifest.startup, ["localPrepareEntry"], "startup")
    if (safeRelativePath(manifest.startup.localPrepareEntry, "startup.localPrepareEntry")
        !== CONTRACT.localPrepareEntry) {
        fail(`startup.localPrepareEntry must be ${CONTRACT.localPrepareEntry}`)
    }

    exactKeys(
        manifest.requires,
        ["dependencyLock", "minDataSchema", "node", "runtimeApi", "targetDataSchema"],
        "requires",
    )
    if (manifest.requires.runtimeApi !== CONTRACT.runtimeApiVersion) fail("requires.runtimeApi must be 1")
    if (typeof manifest.requires.dependencyLock !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(manifest.requires.dependencyLock)) {
        fail("requires.dependencyLock must be a lowercase SHA-256 digest")
    }
    if (dependencyLock !== undefined) {
        if (typeof dependencyLock !== "string" || !/^sha256:[0-9a-f]{64}$/.test(dependencyLock)) {
            fail("Runtime Pack dependencyLock must be a lowercase SHA-256 digest")
        }
        if (!crypto.timingSafeEqual(
            Buffer.from(manifest.requires.dependencyLock),
            Buffer.from(dependencyLock),
        )) fail("Runtime Pack dependencyLock is incompatible")
    }
    const requiredNode = parseNodeRequirement(manifest.requires.node)
    const currentMatch = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!currentMatch) fail("current Node version is invalid")
    const currentNode = currentMatch.slice(1).map(Number)
    if (compareVersions(currentNode, requiredNode) < 0) fail("current Node version is incompatible")
    const { minDataSchema, targetDataSchema } = manifest.requires
    if (minDataSchema !== CONTRACT.minimumDataSchema
        || targetDataSchema !== CONTRACT.currentDataSchema) {
        fail(`data schema range must be exactly ${CONTRACT.minimumDataSchema} through ${CONTRACT.currentDataSchema}`)
    }
    if (dataSchema !== undefined) {
        if (!Number.isSafeInteger(dataSchema)
            || dataSchema < minDataSchema
            || dataSchema > targetDataSchema) {
            fail("requested data schema is incompatible")
        }
    }

    exactKeys(manifest.admin, ["path", "required"], "admin")
    if (safeRelativePath(manifest.admin.path, "admin.path") !== CONTRACT.adminPath) {
        fail(`admin.path must be ${CONTRACT.adminPath}`)
    }
    if (manifest.admin.required !== CONTRACT.adminRequired) fail("admin.required must be true")

    exactKeys(manifest.assets, ["minClientAssetVersion", "supportedModes"], "assets")
    if (manifest.assets.minClientAssetVersion !== CONTRACT.bundledCdnCatalogVersion) {
        fail(`assets.minClientAssetVersion must be ${CONTRACT.bundledCdnCatalogVersion}`)
    }
    if (!Array.isArray(manifest.assets.supportedModes)
        || manifest.assets.supportedModes.length !== CONTRACT.supportedAssetModes.length
        || manifest.assets.supportedModes.some((mode, index) => mode !== CONTRACT.supportedAssetModes[index])) {
        fail("assets.supportedModes is invalid")
    }

    exactKeys(manifest.ports, ["http", "tcp", "hub"], "ports")
    if (manifest.ports.http !== CONTRACT.defaultPorts.http
        || manifest.ports.tcp !== CONTRACT.defaultPorts.tcp
        || manifest.ports.hub !== CONTRACT.defaultPorts.hub) fail("ports are invalid")

    if (!Array.isArray(manifest.files)) fail("files must be an array")
    const seen = new Set()
    let previous = null
    for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index]
        exactKeys(file, ["bytes", "path", "sha256"], `files[${index}]`)
        const relativePath = safeRelativePath(file.path, `files[${index}].path`)
        if (relativePath === MANIFEST_NAME) fail("files must not enumerate server manifest")
        requireOwnedBundlePath(relativePath, false)
        if (seen.has(relativePath)) fail("files paths must be unique")
        if (previous !== null && compareRelativePaths(previous, relativePath) >= 0) {
            fail("files must use stable path sorting")
        }
        seen.add(relativePath)
        previous = relativePath
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) fail(`files[${index}].bytes is invalid`)
        if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            fail(`files[${index}].sha256 is invalid`)
        }
    }
    if (!seen.has(manifest.entry)) fail("entry must be listed in files")
    if (!seen.has(manifest.startup.localPrepareEntry)) {
        fail("startup.localPrepareEntry must be listed in files")
    }
    for (const requiredFile of ["LICENSE", "NOTICE"]) {
        if (!seen.has(requiredFile)) fail(`${requiredFile} is required in files`)
    }
    const adminIndex = `${CONTRACT.adminPath}/index.html`
    if (!seen.has(adminIndex)) {
        fail("required admin index is missing")
    }

    const { bundleId: _ignored, ...digestInput } = manifest
    const expectedBundleId = `sha256:${sha256Hex(canonicalJsonBuffer(digestInput))}`
    if (!crypto.timingSafeEqual(Buffer.from(manifest.bundleId), Buffer.from(expectedBundleId))) {
        fail("bundleId does not match canonical manifest content")
    }
}

function collectBundleFiles(bundleRoot) {
    const files = new Map()

    function visit(absoluteDirectory, relativeDirectory) {
        let entries
        try {
            entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        } catch {
            fail(relativeDirectory ? `directory "${relativeDirectory}" is unreadable` : "bundle root is unreadable")
        }
        entries.sort((left, right) => compareRelativePaths(left.name, right.name))

        for (const entry of entries) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            safeRelativePath(relativePath, "bundle file path")
            const absolutePath = path.join(absoluteDirectory, entry.name)
            let status
            try {
                status = fs.lstatSync(absolutePath)
            } catch {
                fail(`bundle entry "${relativePath}" is unreadable`)
            }
            if (status.isSymbolicLink()) fail(`bundle entry "${relativePath}" must not be a symbolic link`)
            if (relativePath !== MANIFEST_NAME) requireOwnedBundlePath(relativePath, status.isDirectory())
            if (status.isDirectory()) {
                visit(absolutePath, relativePath)
            } else if (status.isFile()) {
                if (relativePath !== MANIFEST_NAME) files.set(relativePath, absolutePath)
            } else {
                fail(`bundle entry "${relativePath}" must be a regular file or directory`)
            }
        }
    }

    visit(bundleRoot, "")
    return files
}

function verifyServerBundle(options = {}) {
    const bundleRoot = path.resolve(options.bundleRoot ?? path.resolve(__dirname, "../../dist/server-bundle"))
    let rootStatus
    try {
        rootStatus = fs.lstatSync(bundleRoot)
    } catch {
        fail("bundle root is missing")
    }
    if (rootStatus.isSymbolicLink()) fail("bundle root must not be a symbolic link")
    if (!rootStatus.isDirectory()) fail("bundle root must be a directory")

    const manifestBytes = readRegularBytes(path.join(bundleRoot, MANIFEST_NAME), "server manifest")
    let manifest
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
        fail("server manifest is invalid JSON")
    }
    validateManifest(manifest, manifestBytes, options.dataSchema, options.dependencyLock)

    const actualFiles = collectBundleFiles(bundleRoot)
    const expectedPaths = new Set(manifest.files.map(file => file.path))
    for (const expectedPath of expectedPaths) {
        if (!actualFiles.has(expectedPath)) fail(`bundle file set is missing "${expectedPath}"`)
    }
    for (const actualPath of actualFiles.keys()) {
        if (!expectedPaths.has(actualPath)) fail(`bundle file set has extra file "${actualPath}"`)
    }

    for (const file of manifest.files) {
        const bytes = readRegularBytes(actualFiles.get(file.path), `bundle file "${file.path}"`)
        if (bytes.length !== file.bytes) fail(`bundle file "${file.path}" has the wrong size`)
        const digest = sha256Hex(bytes)
        if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(file.sha256))) {
            fail(`bundle file "${file.path}" has the wrong hash`)
        }
    }

    let bundleContract
    try {
        bundleContract = loadServerReleaseContract(bundleRoot)
    } catch {
        fail("bundle release contract is missing or invalid")
    }
    if (!canonicalJsonBuffer(bundleContract).equals(canonicalJsonBuffer(CONTRACT))) {
        fail("bundle release contract does not match repository contract")
    }

    return manifest
}

function parseArguments(argv) {
    let bundleRoot
    let dataSchema
    let dependencyLock
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--data-schema") {
            if (dataSchema !== undefined || argv[index + 1] === undefined) {
                throw new Error("--data-schema requires one integer")
            }
            const value = argv[++index]
            if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("--data-schema requires one non-negative integer")
            dataSchema = Number(value)
        } else if (argument === "--dependency-lock") {
            if (dependencyLock !== undefined || argv[index + 1] === undefined) {
                throw new Error("--dependency-lock requires one SHA-256 digest")
            }
            dependencyLock = argv[++index]
            if (!/^sha256:[0-9a-f]{64}$/.test(dependencyLock)) {
                throw new Error("--dependency-lock requires one SHA-256 digest")
            }
        } else if (!argument.startsWith("-") && bundleRoot === undefined) {
            bundleRoot = argument
        } else {
            throw new Error(`Unknown verifier argument: ${argument}`)
        }
    }
    return { bundleRoot, dataSchema, dependencyLock }
}

if (require.main === module) {
    try {
        const manifest = verifyServerBundle(parseArguments(process.argv.slice(2)))
        process.stdout.write(`Verified ${manifest.bundleId} with ${manifest.files.length} files\n`)
    } catch (error) {
        process.stderr.write(`Server bundle verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
        process.exitCode = 1
    }
}

module.exports = { parseArguments, verifyServerBundle }
