#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { verifyServerBundle } = require("./verify.cjs")
const { writeStoredZip } = require("./zip.cjs")

const DEFAULT_BUNDLE_ROOT = path.resolve(__dirname, "../../dist/server-bundle")
const DEFAULT_OUTPUT_DIRECTORY = path.resolve(__dirname, "../../dist")
const READ_BUFFER_SIZE = 64 * 1024

function fail(message) {
    throw new Error(message)
}

function parseArguments(argv) {
    let bundleRoot
    let outputDirectory
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument !== "--bundle" && argument !== "--output") {
            throw new Error("Unknown pack argument")
        }

        const value = argv[index + 1]
        if (value === undefined || value.length === 0 || value.startsWith("--")) {
            throw new Error(`${argument} requires exactly one path`)
        }
        if (argument === "--bundle") {
            if (bundleRoot !== undefined) throw new Error("--bundle may only be specified once")
            bundleRoot = value
        } else {
            if (outputDirectory !== undefined) throw new Error("--output may only be specified once")
            outputDirectory = value
        }
        index++
    }
    return {
        bundleRoot: bundleRoot ?? DEFAULT_BUNDLE_ROOT,
        outputDirectory: outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY,
    }
}

function requireOutputDirectory(io, outputDirectory) {
    let status
    try {
        status = io.statSync(outputDirectory)
    } catch {
        fail("Output directory is missing or unreadable")
    }
    if (!status.isDirectory()) fail("Output directory must be a directory")
}

function pathExists(io, filePath) {
    try {
        io.lstatSync(filePath)
        return true
    } catch (error) {
        if (error && error.code === "ENOENT") return false
        throw error
    }
}

function uniqueCandidatePath(io, outputDirectory, archiveName) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const candidatePath = path.join(
            outputDirectory,
            `.${archiveName}.candidate-${crypto.randomUUID()}`,
        )
        if (!pathExists(io, candidatePath)) return candidatePath
    }
    fail("Could not reserve a unique archive candidate name")
}

function openRegularFile(io, filePath, label) {
    let status
    try {
        status = io.lstatSync(filePath)
    } catch {
        fail(`${label} is missing or unreadable`)
    }
    if (status.isSymbolicLink() || !status.isFile()) fail(`${label} must be a regular file`)

    let descriptor
    try {
        descriptor = io.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const openedStatus = io.fstatSync(descriptor)
        if (!openedStatus.isFile()
            || status.dev !== openedStatus.dev
            || status.ino !== openedStatus.ino) {
            fail(`${label} changed while it was opened`)
        }
        return { descriptor, status: openedStatus }
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                io.closeSync(descriptor)
            } catch {
                // Preserve the comparison failure.
            }
        }
        throw error
    }
}

function sameOpenedFile(io, filePath, status) {
    try {
        const current = io.lstatSync(filePath)
        return !current.isSymbolicLink()
            && current.isFile()
            && current.dev === status.dev
            && current.ino === status.ino
            && current.size === status.size
    } catch {
        return false
    }
}

function filesEqual(io, candidatePath, outputPath) {
    const candidate = openRegularFile(io, candidatePath, "Archive candidate")
    let output
    try {
        output = openRegularFile(io, outputPath, "Existing archive")
        if (candidate.status.size !== output.status.size) return false

        const candidateBuffer = Buffer.allocUnsafe(READ_BUFFER_SIZE)
        const outputBuffer = Buffer.allocUnsafe(READ_BUFFER_SIZE)
        while (true) {
            const candidateRead = io.readSync(
                candidate.descriptor,
                candidateBuffer,
                0,
                candidateBuffer.length,
                null,
            )
            const outputRead = io.readSync(
                output.descriptor,
                outputBuffer,
                0,
                outputBuffer.length,
                null,
            )
            if (candidateRead !== outputRead) return false
            if (candidateRead === 0) break
            if (!candidateBuffer.subarray(0, candidateRead)
                .equals(outputBuffer.subarray(0, outputRead))) return false
        }
        if (!sameOpenedFile(io, candidatePath, candidate.status)
            || !sameOpenedFile(io, outputPath, output.status)) {
            fail("Archive changed during byte comparison")
        }
        return true
    } finally {
        io.closeSync(candidate.descriptor)
        if (output !== undefined) io.closeSync(output.descriptor)
    }
}

function cleanupCandidate(io, candidatePath, warnings) {
    try {
        io.unlinkSync(candidatePath)
    } catch (error) {
        if (error && error.code === "ENOENT") return
        warnings.push(
            `Archive committed; cleanup remains for temporary file "${path.basename(candidatePath)}"`,
        )
    }
}

function publishCandidate(io, candidatePath, outputPath, warnings) {
    let status
    try {
        io.linkSync(candidatePath, outputPath)
        status = "created"
    } catch (error) {
        if ((!error || error.code !== "EEXIST") && !pathExists(io, outputPath)) throw error
        if (!filesEqual(io, candidatePath, outputPath)) {
            try {
                io.unlinkSync(candidatePath)
            } catch {
                fail(
                    `Archive destination differs; cleanup remains for temporary file "${path.basename(candidatePath)}"`,
                )
            }
            fail("Archive destination exists and differs from the verified bundle candidate")
        }
        status = "unchanged"
    }
    cleanupCandidate(io, candidatePath, warnings)
    return status
}

function packServerBundle(options = {}) {
    if (options === null || typeof options !== "object") fail("Pack options must be an object")
    const io = options.fs ?? fs
    const bundleRoot = path.resolve(options.bundleRoot ?? DEFAULT_BUNDLE_ROOT)
    const outputDirectory = path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY)

    const verifiedManifest = verifyServerBundle({ bundleRoot })
    requireOutputDirectory(io, outputDirectory)
    const archiveName = `starpoint-cn-server-bundle-${verifiedManifest.serverVersion}.zip`
    const outputPath = path.join(outputDirectory, archiveName)
    const candidatePath = uniqueCandidatePath(io, outputDirectory, archiveName)
    const zipResult = writeStoredZip({
        bundleRoot,
        outputPath: candidatePath,
        verifiedManifest,
        fs: io,
    })
    const warnings = []
    if (zipResult.cleanupPending) {
        warnings.push(
            `Archive committed; cleanup remains for temporary file "${zipResult.temporaryFile}"`,
        )
    }
    const status = publishCandidate(io, candidatePath, outputPath, warnings)
    return {
        archiveName,
        cleanupPending: warnings.length > 0,
        outputPath,
        status,
        warnings,
    }
}

function publicErrorMessage(error) {
    const message = error instanceof Error ? error.message : "unknown error"
    return message
        .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"\r\n]+\1/g, "$1<path>$1")
        .replace(/(^|[\s:(])(?:[A-Za-z]:[\\/]|\/)[^\s'")]+/g, "$1<path>")
}

if (require.main === module) {
    try {
        const result = packServerBundle(parseArguments(process.argv.slice(2)))
        process.stdout.write(`Packed ${result.archiveName} (${result.status})\n`)
        for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`)
    } catch (error) {
        process.stderr.write(`Server bundle packaging failed: ${publicErrorMessage(error)}\n`)
        process.exitCode = 1
    }
}

module.exports = { packServerBundle, parseArguments }
