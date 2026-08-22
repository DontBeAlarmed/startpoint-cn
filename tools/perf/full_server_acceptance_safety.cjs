"use strict"

const os = require("node:os")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { isIP } = require("node:net")
const { types: { isProxy } } = require("node:util")

const MAX_SNAPSHOT_DEPTH = 32
const MAX_SNAPSHOT_NODES = 50_000
const MAX_SNAPSHOT_STRING_LENGTH = 1_000_000
const MAX_SNAPSHOT_STRING_TOTAL = 4_000_000
const MAX_ERROR_DEPTH = 4
const MAX_ERROR_NODES = 16
const MAX_AGGREGATE_ERRORS = 8
const MAX_ERROR_MESSAGE_LENGTH = 160

const SENSITIVE_LABEL = /\b(?:(?:login|session)[_-]?token|(?:viewer|device|room)[_-]?id|raw[_-]?(?:frame|body)|token|device|viewer|room|raw|body)\b/i
const TOKEN_ASSIGNMENT = /(?:^|[^a-z\d_-])["']?[a-z\d_-]*token[a-z\d_-]*["']?\s*(?:=|:)\s*\S/i
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const URL_AUTHORITY = /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#]+/i
const POSIX_ABSOLUTE_PATH = /(?:^|[\s"'(=])\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]*/
const WINDOWS_DRIVE_PATH = /\b[a-z]:[\\/][^\s"'<>]+/i
const WINDOWS_UNC_PATH = /\\\\[^\\\s"'<>]+\\[^\s"'<>]+/
const DOTTED_HOSTNAME = /\b(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?\b/i

function unsafeStructuredValue() {
    return new TypeError("unsafe structured value")
}

function snapshotNode(value, state, depth) {
    if (state.nodes >= MAX_SNAPSHOT_NODES) throw unsafeStructuredValue()
    state.nodes++
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw unsafeStructuredValue()
        return value
    }
    if (typeof value === "string") {
        if (value.length > MAX_SNAPSHOT_STRING_LENGTH
            || state.stringLength + value.length > MAX_SNAPSHOT_STRING_TOTAL) {
            throw unsafeStructuredValue()
        }
        state.stringLength += value.length
        return value
    }
    if (typeof value !== "object" || isProxy(value) || depth >= MAX_SNAPSHOT_DEPTH) {
        throw unsafeStructuredValue()
    }
    if (state.ancestors.has(value)) throw unsafeStructuredValue()
    state.ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) throw unsafeStructuredValue()
            const keys = Reflect.ownKeys(value)
            if (keys.length !== value.length + 1 || !keys.includes("length")) {
                throw unsafeStructuredValue()
            }
            const result = new Array(value.length)
            for (let index = 0; index < value.length; index++) {
                const key = String(index)
                const descriptor = Object.getOwnPropertyDescriptor(value, key)
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw unsafeStructuredValue()
                }
                result[index] = snapshotNode(descriptor.value, state, depth + 1)
            }
            if (!keys.every(key => key === "length"
                || (typeof key === "string"
                    && /^(?:0|[1-9][0-9]*)$/.test(key)
                    && Number(key) < value.length))) {
                throw unsafeStructuredValue()
            }
            return result
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) throw unsafeStructuredValue()
        const keys = Reflect.ownKeys(value)
        const result = {}
        for (const key of keys) {
            if (typeof key !== "string") throw unsafeStructuredValue()
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !("value" in descriptor)) {
                throw unsafeStructuredValue()
            }
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: snapshotNode(descriptor.value, state, depth + 1),
                writable: true,
            })
        }
        return result
    } finally {
        state.ancestors.delete(value)
    }
}

function snapshotJsonValue(value) {
    return snapshotNode(value, {
        ancestors: new Set(),
        nodes: 0,
        stringLength: 0,
    }, 0)
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function containsIpAddress(value) {
    if (IPV4.test(value)) return true
    for (const token of value.match(/[a-z\d:.%_-]+/gi) ?? []) {
        const zoneIndex = token.indexOf("%")
        const candidate = zoneIndex === -1 ? token : token.slice(0, zoneIndex)
        if (isIP(candidate) !== 0) return true
    }
    return false
}

function containsSensitiveMessage(value) {
    const hostname = os.hostname()
    const hostnamePattern = typeof hostname === "string" && hostname.length > 0
        ? new RegExp(`(?:^|[^a-z\\d-])${escapeRegExp(hostname)}(?:$|[^a-z\\d-])`, "i")
        : null
    return SENSITIVE_LABEL.test(value)
        || TOKEN_ASSIGNMENT.test(value)
        || containsIpAddress(value)
        || URL_AUTHORITY.test(value)
        || POSIX_ABSOLUTE_PATH.test(value)
        || WINDOWS_DRIVE_PATH.test(value)
        || WINDOWS_UNC_PATH.test(value)
        || DOTTED_HOSTNAME.test(value)
        || hostnamePattern?.test(value) === true
}

function genericSerializedError(message = "operation failed") {
    return { name: "Error", message }
}

function sanitizeErrorMessage(value) {
    if (typeof value !== "string" || value.length === 0
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        return "operation failed"
    }
    if (containsSensitiveMessage(value)) return "[redacted]"
    return value.length <= MAX_ERROR_MESSAGE_LENGTH
        ? value
        : `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
}

function ownDataValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function serializeErrorNode(error, state, depth) {
    if (depth >= MAX_ERROR_DEPTH || state.nodes >= MAX_ERROR_NODES) {
        return genericSerializedError("error detail truncated")
    }
    state.nodes++
    if (typeof error === "string") {
        return genericSerializedError(sanitizeErrorMessage(error))
    }
    if (error === null || typeof error !== "object" || isProxy(error)) {
        return genericSerializedError()
    }
    if (state.ancestors.has(error)) return genericSerializedError("cyclic error detail")
    state.ancestors.add(error)
    try {
        const errors = ownDataValue(error, "errors")
        const ownName = ownDataValue(error, "name")
        const diagnosticName = typeof ownName === "string"
            && /^[A-Z][A-Za-z\d]{0,31}Error$/.test(ownName)
            && !containsSensitiveMessage(ownName)
            ? ownName
            : Array.isArray(errors) && !isProxy(errors) ? "AggregateError" : "Error"
        const result = {
            name: diagnosticName,
            message: sanitizeErrorMessage(ownDataValue(error, "message")),
        }
        const cause = ownDataValue(error, "cause")
        if (cause !== undefined) result.cause = serializeErrorNode(cause, state, depth + 1)
        if (Array.isArray(errors) && !isProxy(errors)
            && Object.getPrototypeOf(errors) === Array.prototype) {
            result.errors = []
            const count = Math.min(errors.length, MAX_AGGREGATE_ERRORS)
            for (let index = 0; index < count; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(errors, String(index))
                result.errors.push(descriptor?.enumerable && "value" in descriptor
                    ? serializeErrorNode(descriptor.value, state, depth + 1)
                    : genericSerializedError("error detail unavailable"))
            }
            if (errors.length > count) {
                result.errors.push(genericSerializedError("error detail truncated"))
            }
        }
        return result
    } catch {
        return genericSerializedError()
    } finally {
        state.ancestors.delete(error)
    }
}

function serializeError(error) {
    try {
        return serializeErrorNode(error, { ancestors: new Set(), nodes: 0 }, 0)
    } catch {
        return genericSerializedError()
    }
}

function inspectOutputPath(filePath, fileSystem) {
    const resolved = path.resolve(filePath)
    let stats = null
    let realPath = null
    try {
        stats = fileSystem.lstatSync(resolved)
        if (stats.isSymbolicLink()) throw new Error("output target must not be a symbolic link")
        if (!stats.isFile()) throw new Error("output target must be a regular file")
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

function assertDistinctOutputPaths(outputPath, referencePath, fileSystem) {
    if (outputPath === null || referencePath === null) return
    const output = inspectOutputPath(outputPath, fileSystem)
    const reference = inspectOutputPath(referencePath, fileSystem)
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

function atomicWriteFile(filePath, contents, fileSystem) {
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

module.exports = {
    assertDistinctOutputPaths,
    atomicWriteFile,
    serializeError,
    snapshotJsonValue,
}
