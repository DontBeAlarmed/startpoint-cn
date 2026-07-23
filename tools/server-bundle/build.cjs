#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { canonicalJsonBuffer, sha256Hex } = require("./canonical-json.cjs")
const { verifyServerBundle } = require("./verify.cjs")

const MANIFEST_NAME = "server-manifest.json"
const DEFAULT_OUTPUT = "dist/server-bundle"

function compareRelativePaths(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function isContainedBy(candidate, root) {
    const relative = path.relative(root, candidate)
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function lstat(filePath, label, { optional = false } = {}) {
    try {
        return fs.lstatSync(filePath)
    } catch (error) {
        if (optional && error && error.code === "ENOENT") return null
        throw new Error(`${label} is missing or unreadable`)
    }
}

function requireDirectory(filePath, label) {
    const status = lstat(filePath, label)
    if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!status.isDirectory()) throw new Error(`${label} must be a directory`)
}

function readRegularFile(filePath, label) {
    const status = lstat(filePath, label)
    if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!status.isFile()) throw new Error(`${label} must be a regular file`)

    let descriptor
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const openedStatus = fs.fstatSync(descriptor)
        if (!openedStatus.isFile()) throw new Error(`${label} must be a regular file`)
        return fs.readFileSync(descriptor)
    } catch (error) {
        if (error instanceof Error && error.message === `${label} must be a regular file`) throw error
        throw new Error(`${label} could not be read as a regular file`)
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor)
    }
}

function validateBundlePath(relativePath) {
    if (typeof relativePath !== "string"
        || relativePath.length === 0
        || relativePath.includes("\\")
        || relativePath.includes("\0")
        || path.posix.isAbsolute(relativePath)
        || /^[A-Za-z]:/.test(relativePath)
        || path.posix.normalize(relativePath) !== relativePath
        || relativePath.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
        throw new Error("Builder produced an unsafe bundle path")
    }
}

function copyTree({ sourceRoot, destinationRoot, destinationPrefix, exclude, files }) {
    requireDirectory(sourceRoot, `Input "${destinationPrefix}"`)

    function visit(sourceDirectory, relativeDirectory) {
        let names
        try {
            names = fs.readdirSync(sourceDirectory).sort(compareRelativePaths)
        } catch {
            throw new Error(`Input "${destinationPrefix}" could not be traversed`)
        }

        for (const name of names) {
            const sourceRelative = relativeDirectory ? `${relativeDirectory}/${name}` : name
            if (exclude(sourceRelative)) continue

            const bundleRelative = `${destinationPrefix}/${sourceRelative}`
            validateBundlePath(bundleRelative)
            const sourcePath = path.join(sourceDirectory, name)
            const status = lstat(sourcePath, `Input "${bundleRelative}"`)
            if (status.isSymbolicLink()) {
                throw new Error(`Input "${bundleRelative}" must not be a symbolic link`)
            }
            if (status.isDirectory()) {
                visit(sourcePath, sourceRelative)
                continue
            }
            if (!status.isFile()) {
                throw new Error(`Input "${bundleRelative}" must be a regular file or directory`)
            }

            const bytes = readRegularFile(sourcePath, `Input "${bundleRelative}"`)
            const destination = path.join(destinationRoot, ...bundleRelative.split("/"))
            fs.mkdirSync(path.dirname(destination), { recursive: true })
            fs.writeFileSync(destination, bytes, { mode: 0o644 })
            files.push({ path: bundleRelative, bytes: bytes.length, sha256: sha256Hex(bytes) })
        }
    }

    visit(sourceRoot, "")
}

function copySingleFile({ sourcePath, destinationRoot, bundleRelative, files }) {
    validateBundlePath(bundleRelative)
    const bytes = readRegularFile(sourcePath, `Input "${bundleRelative}"`)
    const destination = path.join(destinationRoot, ...bundleRelative.split("/"))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, bytes, { mode: 0o644 })
    files.push({ path: bundleRelative, bytes: bytes.length, sha256: sha256Hex(bytes) })
}

function inspectOptionalAdmin(projectRoot) {
    const adminRoot = path.join(projectRoot, "web/dist")
    const rootStatus = lstat(adminRoot, "Optional admin input", { optional: true })
    if (rootStatus === null) return null
    if (rootStatus.isSymbolicLink()) throw new Error("Optional admin input must not be a symbolic link")
    if (!rootStatus.isDirectory()) throw new Error("Optional admin input must be a directory")

    const indexPath = path.join(adminRoot, "index.html")
    const indexStatus = lstat(indexPath, "Optional admin index", { optional: true })
    if (indexStatus === null) return null
    if (indexStatus.isSymbolicLink()) throw new Error("Optional admin index must not be a symbolic link")
    if (!indexStatus.isFile()) throw new Error("Optional admin index must be a regular file")
    return adminRoot
}

function assertOwnedOutput(outputRoot) {
    const outputStatus = lstat(outputRoot, "Existing output", { optional: true })
    if (outputStatus === null) return false
    if (outputStatus.isSymbolicLink() || !outputStatus.isDirectory()) {
        throw new Error("Existing output is not owned by the server bundle builder")
    }

    try {
        verifyServerBundle({ bundleRoot: outputRoot })
    } catch {
        throw new Error("Existing output is not owned by the server bundle builder")
    }
    return true
}

function publishBundle(temporaryRoot, outputRoot, hadExistingOutput) {
    if (!hadExistingOutput) {
        fs.renameSync(temporaryRoot, outputRoot)
        return
    }

    const backupRoot = `${outputRoot}.previous-${crypto.randomUUID()}`
    fs.renameSync(outputRoot, backupRoot)
    try {
        fs.renameSync(temporaryRoot, outputRoot)
    } catch (error) {
        fs.renameSync(backupRoot, outputRoot)
        throw error
    }
    fs.rmSync(backupRoot, { recursive: true, force: true })
}

function buildServerBundle(options = {}) {
    const projectRoot = path.resolve(options.projectRoot ?? path.resolve(__dirname, "../.."))
    const outputRoot = path.resolve(projectRoot, options.outputRoot ?? DEFAULT_OUTPUT)
    const packageBytes = readRegularFile(path.join(projectRoot, "package.json"), "Input package.json")
    let packageJson
    try {
        packageJson = JSON.parse(packageBytes.toString("utf8"))
    } catch {
        throw new Error("Input package.json is invalid JSON")
    }
    if (packageJson.name !== "starpoint-cn"
        || typeof packageJson.version !== "string"
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)
        || typeof packageJson.engines?.node !== "string"
        || !/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageJson.engines.node)) {
        throw new Error("Input package.json has invalid server bundle metadata")
    }

    const adminRoot = inspectOptionalAdmin(projectRoot)
    const inputs = [
        path.join(projectRoot, "out"),
        path.join(projectRoot, "assets"),
        path.join(projectRoot, "web/pages"),
        path.join(projectRoot, "web/public"),
        ...(adminRoot === null ? [] : [adminRoot]),
    ].map(input => path.resolve(input))
    for (const input of inputs) {
        if (isContainedBy(outputRoot, input)) {
            throw new Error("Bundle output must not be inside an input root")
        }
    }

    const hadExistingOutput = assertOwnedOutput(outputRoot)
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
    const temporaryRoot = `${outputRoot}.building-${crypto.randomUUID()}`
    fs.mkdirSync(temporaryRoot, { recursive: false })

    try {
        const files = []
        copyTree({
            sourceRoot: path.join(projectRoot, "out"),
            destinationRoot: temporaryRoot,
            destinationPrefix: "out",
            exclude: relative => relative === ".tsbuildinfo-cn",
            files,
        })
        copyTree({
            sourceRoot: path.join(projectRoot, "assets"),
            destinationRoot: temporaryRoot,
            destinationPrefix: "assets",
            exclude: relative => relative === "asset-patch" || relative.startsWith("asset-patch/"),
            files,
        })
        copyTree({
            sourceRoot: path.join(projectRoot, "web/pages"),
            destinationRoot: temporaryRoot,
            destinationPrefix: "web/pages",
            exclude: () => false,
            files,
        })
        copyTree({
            sourceRoot: path.join(projectRoot, "web/public"),
            destinationRoot: temporaryRoot,
            destinationPrefix: "web/public",
            exclude: relative => relative === "comic" || relative.startsWith("comic/"),
            files,
        })
        if (adminRoot !== null) {
            copyTree({
                sourceRoot: adminRoot,
                destinationRoot: temporaryRoot,
                destinationPrefix: "web/dist",
                exclude: () => false,
                files,
            })
        }
        copySingleFile({ sourcePath: path.join(projectRoot, "LICENSE"), destinationRoot: temporaryRoot, bundleRelative: "LICENSE", files })
        copySingleFile({ sourcePath: path.join(projectRoot, "NOTICE"), destinationRoot: temporaryRoot, bundleRelative: "NOTICE", files })
        files.sort((left, right) => compareRelativePaths(left.path, right.path))
        if (!files.some(file => file.path === "out/cn-server.js")) {
            throw new Error("Bundle entry out/cn-server.js is missing")
        }

        const digestInput = {
            schemaVersion: 1,
            name: "starpoint-cn",
            serverVersion: packageJson.version,
            entry: "out/cn-server.js",
            requires: {
                runtimeApi: 1,
                node: packageJson.engines.node,
                minDataSchema: 0,
                targetDataSchema: 4,
            },
            admin: { path: "web/dist", required: false },
            assets: {
                supportedModes: ["client-owned", "local", "remote"],
                minClientAssetVersion: "1.4.54",
            },
            ports: { http: 8001, tcp: 8003 },
            files,
        }
        const manifest = {
            ...digestInput,
            bundleId: `sha256:${sha256Hex(canonicalJsonBuffer(digestInput))}`,
        }
        fs.writeFileSync(path.join(temporaryRoot, MANIFEST_NAME), canonicalJsonBuffer(manifest), { mode: 0o644 })
        publishBundle(temporaryRoot, outputRoot, hadExistingOutput)
        return manifest
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true })
        throw error
    }
}

function parseArguments(argv) {
    let outputRoot
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--output") {
            if (outputRoot !== undefined || !argv[index + 1]) throw new Error("--output requires one path")
            outputRoot = argv[++index]
        } else if (!argument.startsWith("-") && outputRoot === undefined) {
            outputRoot = argument
        } else {
            throw new Error(`Unknown builder argument: ${argument}`)
        }
    }
    return { outputRoot }
}

if (require.main === module) {
    try {
        const manifest = buildServerBundle(parseArguments(process.argv.slice(2)))
        process.stdout.write(`Built ${manifest.bundleId} with ${manifest.files.length} files\n`)
    } catch (error) {
        process.stderr.write(`Server bundle build failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
        process.exitCode = 1
    }
}

module.exports = { buildServerBundle, parseArguments }
