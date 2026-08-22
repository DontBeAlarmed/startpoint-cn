"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

function inspectOutputPath(filePath, fileSystem, { allowHardLinks = false } = {}) {
    const resolved = path.resolve(filePath)
    let stats = null
    let realPath = null
    try {
        stats = fileSystem.lstatSync(resolved)
        if (stats.isSymbolicLink()) throw new Error("output target must not be a symbolic link")
        if (!stats.isFile()) throw new Error("output target must be a regular file")
        if (!allowHardLinks && stats.nlink !== 1) {
            throw new Error("output target must not be a hard-link alias")
        }
        realPath = fileSystem.realpathSync(resolved)
    } catch (error) {
        if (error?.code !== "ENOENT") throw error
    }
    const parentRealPath = fileSystem.realpathSync(path.dirname(resolved))
    const parentStats = fileSystem.statSync(parentRealPath)
    if (!parentStats.isDirectory()) throw new Error("output parent must be a directory")
    const basename = path.basename(resolved)
    return {
        basename,
        parentRealPath,
        parentStats,
        physicalTarget: path.join(parentRealPath, basename),
        realPath,
        resolved,
        stats,
    }
}

function caseVariant(filePath) {
    for (let index = filePath.length - 1; index >= 0; index--) {
        const character = filePath[index]
        if (character >= "a" && character <= "z") {
            return `${filePath.slice(0, index)}${character.toUpperCase()}${filePath.slice(index + 1)}`
        }
        if (character >= "A" && character <= "Z") {
            return `${filePath.slice(0, index)}${character.toLowerCase()}${filePath.slice(index + 1)}`
        }
    }
    return null
}

function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino
}

function isCaseInsensitiveParent(parentPath, parentStats, fileSystem) {
    const variant = caseVariant(parentPath)
    if (variant === null) return false
    try {
        return sameFileIdentity(parentStats, fileSystem.statSync(variant))
    } catch {
        return false
    }
}

function assertDistinctOutputPaths(outputPath, referencePath, fileSystem = fs) {
    if (outputPath === null || referencePath === null) return
    const inspectOptions = { allowHardLinks: true }
    const output = inspectOutputPath(outputPath, fileSystem, inspectOptions)
    const reference = inspectOutputPath(referencePath, fileSystem, inspectOptions)
    const sameRealPath = output.realPath !== null
        && reference.realPath !== null
        && output.realPath === reference.realPath
    const sameTargetInode = output.stats !== null
        && reference.stats !== null
        && sameFileIdentity(output.stats, reference.stats)
    const sameParent = output.parentRealPath === reference.parentRealPath
        || sameFileIdentity(output.parentStats, reference.parentStats)
    const samePhysicalTarget = output.physicalTarget === reference.physicalTarget
    const sameCaseFoldedBasename = sameParent
        && isCaseInsensitiveParent(output.parentRealPath, output.parentStats, fileSystem)
        && output.basename.toLocaleLowerCase("en-US")
            === reference.basename.toLocaleLowerCase("en-US")
    if (output.resolved === reference.resolved
        || sameRealPath
        || sameTargetInode
        || samePhysicalTarget
        || sameCaseFoldedBasename) {
        throw new Error("--output and --write-reference resolve to the same file alias")
    }
}

function atomicWriteFile(filePath, contents, fileSystem = fs) {
    const targetState = inspectOutputPath(filePath, fileSystem)
    const target = targetState.resolved
    const mode = targetState.stats === null ? 0o600 : targetState.stats.mode & 0o777
    const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let primaryError = null
    let renamed = false
    try {
        fileSystem.writeFileSync(temporary, contents, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        })
        fileSystem.chmodSync(temporary, mode)
        fileSystem.renameSync(temporary, target)
        renamed = true
    } catch (error) {
        primaryError = error
    }
    let cleanupError = null
    if (!renamed) {
        try {
            fileSystem.rmSync(temporary, { force: true })
        } catch (error) {
            cleanupError = error
        }
    }
    if (primaryError !== null && cleanupError !== null) {
        throw new AggregateError([primaryError, cleanupError], "atomic output write and cleanup failed")
    }
    if (primaryError !== null) throw primaryError
    if (cleanupError !== null) throw cleanupError
}

module.exports = { assertDistinctOutputPaths, atomicWriteFile }
