#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { canonicalJsonBuffer, sha256Hex } = require("../server-bundle/canonical-json.cjs")

const MANIFEST_NAME = "runtime-pack-manifest.json"
const ROOT_KEYS = [
    "dependencyLock",
    "entry",
    "executables",
    "files",
    "node",
    "runtimeApi",
    "runtimeId",
    "schemaVersion",
]
const NODE_KEYS = ["abi", "arch", "platform", "version"]

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

function isOwnedRuntimePath(relativePath) {
    return relativePath === "node"
        || relativePath.startsWith("node/")
        || relativePath === "node_modules"
        || relativePath.startsWith("node_modules/")
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

function requireDigest(value, label) {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        fail(`${label} must be a lowercase SHA-256 digest`)
    }
}

function validateManifest(manifest, manifestBytes, options) {
    exactKeys(manifest, ROOT_KEYS, "manifest")
    if (!manifestBytes.equals(canonicalJsonBuffer(manifest))) fail("runtime manifest must be canonical JSON")
    if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1")
    if (manifest.runtimeApi !== 1) fail("runtimeApi must be 1")
    requireDigest(manifest.runtimeId, "runtimeId")
    requireDigest(manifest.dependencyLock, "dependencyLock")
    if (options.expectedRuntimeApi !== undefined && manifest.runtimeApi !== options.expectedRuntimeApi) {
        fail("runtimeApi is incompatible")
    }
    if (options.expectedDependencyLock !== undefined
        && manifest.dependencyLock !== options.expectedDependencyLock) {
        fail("Runtime Pack dependencyLock is incompatible")
    }

    exactKeys(manifest.node, NODE_KEYS, "node")
    if (typeof manifest.node.version !== "string"
        || !/^\d+\.\d+\.\d+$/.test(manifest.node.version)) {
        fail("node.version must be a complete semantic version")
    }
    if (typeof manifest.node.abi !== "string" || !/^\d+$/.test(manifest.node.abi)) {
        fail("node.abi must be a decimal string")
    }
    if (typeof manifest.node.platform !== "string"
        || !/^[a-z][a-z0-9-]*$/.test(manifest.node.platform)) {
        fail("node.platform is invalid")
    }
    if (typeof manifest.node.arch !== "string" || !/^[a-z0-9_-]+$/.test(manifest.node.arch)) {
        fail("node.arch is invalid")
    }
    if (options.expectedPlatform !== undefined && manifest.node.platform !== options.expectedPlatform) {
        fail("Runtime Pack platform is incompatible")
    }
    if (options.expectedArch !== undefined && manifest.node.arch !== options.expectedArch) {
        fail("Runtime Pack architecture is incompatible")
    }
    if (options.expectedNodeAbi !== undefined && manifest.node.abi !== options.expectedNodeAbi) {
        fail("Runtime Pack Node ABI is incompatible")
    }

    if (safeRelativePath(manifest.entry, "entry") !== "node/bin/node") {
        fail("entry must be node/bin/node")
    }
    if (!Array.isArray(manifest.executables) || manifest.executables.length === 0) {
        fail("executables must be a non-empty array")
    }
    let previousExecutable = null
    for (const [index, executable] of manifest.executables.entries()) {
        safeRelativePath(executable, `executables[${index}]`)
        if (!isOwnedRuntimePath(executable)) fail(`executables[${index}] is outside the Runtime Pack`)
        if (previousExecutable !== null && compareRelativePaths(previousExecutable, executable) >= 0) {
            fail("executables must use stable path sorting without duplicates")
        }
        previousExecutable = executable
    }
    if (!manifest.executables.includes(manifest.entry)) fail("entry must be executable")

    if (!Array.isArray(manifest.files)) fail("files must be an array")
    const seen = new Set()
    let previous = null
    for (const [index, file] of manifest.files.entries()) {
        exactKeys(file, ["bytes", "path", "sha256"], `files[${index}]`)
        const relativePath = safeRelativePath(file.path, `files[${index}].path`)
        if (!isOwnedRuntimePath(relativePath)) fail(`Runtime Pack path "${relativePath}" is not allowed`)
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
    if (![...seen].some(relativePath => relativePath.startsWith("node_modules/"))) {
        fail("Runtime Pack must contain production dependencies under node_modules")
    }
    for (const executable of manifest.executables) {
        if (!seen.has(executable)) fail(`executable "${executable}" is not listed in files`)
    }

    const { runtimeId: _ignored, ...digestInput } = manifest
    const expectedRuntimeId = `sha256:${sha256Hex(canonicalJsonBuffer(digestInput))}`
    if (!crypto.timingSafeEqual(Buffer.from(manifest.runtimeId), Buffer.from(expectedRuntimeId))) {
        fail("runtimeId does not match canonical manifest content")
    }
}

function collectRuntimeFiles(runtimeRoot) {
    const files = new Map()

    function visit(absoluteDirectory, relativeDirectory) {
        let entries
        try {
            entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        } catch {
            fail(relativeDirectory ? `directory "${relativeDirectory}" is unreadable` : "Runtime Pack root is unreadable")
        }
        entries.sort((left, right) => compareRelativePaths(left.name, right.name))

        for (const entry of entries) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            safeRelativePath(relativePath, "Runtime Pack file path")
            const absolutePath = path.join(absoluteDirectory, entry.name)
            let status
            try {
                status = fs.lstatSync(absolutePath)
            } catch {
                fail(`Runtime Pack entry "${relativePath}" is unreadable`)
            }
            if (status.isSymbolicLink()) fail(`Runtime Pack entry "${relativePath}" must not be a symbolic link`)
            if (relativePath !== MANIFEST_NAME && !isOwnedRuntimePath(relativePath)) {
                fail(`Runtime Pack has an extra path "${relativePath}"`)
            }
            if (status.isDirectory()) {
                visit(absolutePath, relativePath)
            } else if (status.isFile()) {
                if (relativePath !== MANIFEST_NAME) files.set(relativePath, absolutePath)
            } else {
                fail(`Runtime Pack entry "${relativePath}" must be a regular file or directory`)
            }
        }
    }

    visit(runtimeRoot, "")
    return files
}

function verifyRuntimePack({
    runtimeRoot,
    expectedPlatform,
    expectedArch,
    expectedNodeAbi,
    expectedRuntimeApi,
    expectedDependencyLock,
} = {}) {
    if (typeof runtimeRoot !== "string") fail("runtimeRoot is required")
    const resolvedRoot = path.resolve(runtimeRoot)
    let rootStatus
    try {
        rootStatus = fs.lstatSync(resolvedRoot)
    } catch {
        fail("Runtime Pack root is missing")
    }
    if (rootStatus.isSymbolicLink()) fail("Runtime Pack root must not be a symbolic link")
    if (!rootStatus.isDirectory()) fail("Runtime Pack root must be a directory")

    const manifestBytes = readRegularBytes(
        path.join(resolvedRoot, MANIFEST_NAME),
        "Runtime Pack manifest",
    )
    let manifest
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
        fail("Runtime Pack manifest is invalid JSON")
    }
    validateManifest(manifest, manifestBytes, {
        expectedPlatform,
        expectedArch,
        expectedNodeAbi,
        expectedRuntimeApi,
        expectedDependencyLock,
    })

    const actualFiles = collectRuntimeFiles(resolvedRoot)
    const expectedPaths = new Set(manifest.files.map(file => file.path))
    for (const expectedPath of expectedPaths) {
        if (!actualFiles.has(expectedPath)) fail(`Runtime Pack file set is missing "${expectedPath}"`)
    }
    for (const actualPath of actualFiles.keys()) {
        if (!expectedPaths.has(actualPath)) fail(`Runtime Pack has extra file "${actualPath}"`)
    }

    for (const file of manifest.files) {
        const bytes = readRegularBytes(actualFiles.get(file.path), `Runtime Pack file "${file.path}"`)
        if (bytes.length !== file.bytes) fail(`Runtime Pack file "${file.path}" has the wrong size`)
        const digest = sha256Hex(bytes)
        if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(file.sha256))) {
            fail(`Runtime Pack file "${file.path}" has the wrong hash`)
        }
    }
    return manifest
}

function parseArguments(argv) {
    const options = {}
    const flags = new Map([
        ["--platform", "expectedPlatform"],
        ["--arch", "expectedArch"],
        ["--node-abi", "expectedNodeAbi"],
        ["--runtime-api", "expectedRuntimeApi"],
        ["--dependency-lock", "expectedDependencyLock"],
    ])
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const key = flags.get(argument)
        if (key !== undefined) {
            if (options[key] !== undefined || argv[index + 1] === undefined) {
                throw new Error(`${argument} requires one value`)
            }
            options[key] = argv[++index]
            continue
        }
        if (!argument.startsWith("-") && options.runtimeRoot === undefined) {
            options.runtimeRoot = argument
            continue
        }
        throw new Error(`Unknown verifier argument: ${argument}`)
    }
    if (options.expectedRuntimeApi !== undefined) {
        if (!/^\d+$/.test(options.expectedRuntimeApi)) throw new Error("--runtime-api requires an integer")
        options.expectedRuntimeApi = Number(options.expectedRuntimeApi)
    }
    if (options.expectedDependencyLock !== undefined) requireDigest(options.expectedDependencyLock, "--dependency-lock")
    if (options.runtimeRoot === undefined) throw new Error("Runtime Pack root is required")
    return options
}

if (require.main === module) {
    try {
        const manifest = verifyRuntimePack(parseArguments(process.argv.slice(2)))
        process.stdout.write(`Verified ${manifest.runtimeId} with ${manifest.files.length} files\n`)
    } catch (error) {
        process.stderr.write(`Runtime Pack verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
        process.exitCode = 1
    }
}

module.exports = { parseArguments, verifyRuntimePack }
