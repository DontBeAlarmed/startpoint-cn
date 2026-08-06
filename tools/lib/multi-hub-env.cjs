"use strict"

const { randomBytes } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { parseEnv } = require("node:util")

const TOKEN_KEY = "MULTI_HUB_TOKEN"
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
    "EINVAL",
    "ENOTSUP",
    "EOPNOTSUPP",
])

class MultiHubEnvError extends Error {
    constructor(code) {
        super(code)
        this.name = "MultiHubEnvError"
        this.code = code
    }
}

function readEnvFile(envPath) {
    try {
        const stats = fs.lstatSync(envPath)
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new MultiHubEnvError("INVALID_MULTI_HUB_ENV_FILE")
        }
        return fs.readFileSync(envPath, "utf8")
    } catch (error) {
        if (error?.code === "ENOENT") return ""
        throw error
    }
}

function invalidEnv() {
    throw new MultiHubEnvError("INVALID_MULTI_HUB_ENV_FILE")
}

function isHorizontalWhitespace(character) {
    return character === " " || character === "\t"
}

function isKeyCharacter(character) {
    return character !== undefined && /[A-Za-z0-9_]/.test(character)
}

function nextLine(text, index) {
    while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++
    if (text[index] === "\r" && text[index + 1] === "\n") return index + 2
    return index < text.length ? index + 1 : index
}

function scanQuotedValue(text, index, quote) {
    const valueStart = index + 1
    index = valueStart
    while (index < text.length && text[index] !== quote) index++
    if (index >= text.length) return invalidEnv()
    return { valueStart, valueEnd: index, next: nextLine(text, index + 1) }
}

function scanUnquotedValue(text, index) {
    const valueStart = index
    while (index < text.length
        && text[index] !== "\n"
        && text[index] !== "\r"
        && text[index] !== "#") index++
    let valueEnd = index
    while (valueEnd > valueStart && isHorizontalWhitespace(text[valueEnd - 1])) valueEnd--
    return { valueStart, valueEnd, next: nextLine(text, index) }
}

function scanTokenAssignments(text) {
    try {
        parseEnv(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
    } catch {
        return invalidEnv()
    }

    const assignments = []
    let index = text.charCodeAt(0) === 0xFEFF ? 1 : 0
    while (index < text.length) {
        while (isHorizontalWhitespace(text[index])) index++
        if (text[index] === "#" || text[index] === "\n" || text[index] === "\r") {
            index = nextLine(text, index)
            continue
        }

        if (text.startsWith("export", index)
            && isHorizontalWhitespace(text[index + "export".length])) {
            index += "export".length
            while (isHorizontalWhitespace(text[index])) index++
        }

        const keyStart = index
        while (isKeyCharacter(text[index])) index++
        const key = text.slice(keyStart, index)
        while (isHorizontalWhitespace(text[index])) index++
        if (key.length === 0 || text[index] !== "=") {
            index = nextLine(text, index)
            continue
        }

        index++
        while (isHorizontalWhitespace(text[index])) index++
        const scanned = text[index] === "'" || text[index] === '"' || text[index] === "`"
            ? scanQuotedValue(text, index, text[index])
            : scanUnquotedValue(text, index)
        if (key === TOKEN_KEY) assignments.push({
            valueStart: scanned.valueStart,
            valueEnd: scanned.valueEnd,
        })
        index = scanned.next
    }
    return assignments
}

function replaceToken(text, token, assignments) {
    if (assignments.length === 1) {
        const assignment = assignments[0]
        return `${text.slice(0, assignment.valueStart)}${token}${text.slice(assignment.valueEnd)}`
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n"
    const separator = text.length === 0 || text.endsWith("\n") ? "" : newline
    return `${text}${separator}${TOKEN_KEY}=${token}${newline}`
}

function isUnsupportedDirectorySyncError(error) {
    return error !== null
        && typeof error === "object"
        && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)
}

function syncParentDirectoryDefault(directory) {
    let descriptor = null
    let primaryError = null
    try {
        descriptor = fs.openSync(directory, "r")
        fs.fsyncSync(descriptor)
    } catch (error) {
        primaryError = error
    }
    if (descriptor !== null) {
        try {
            fs.closeSync(descriptor)
        } catch (error) {
            if (primaryError === null) primaryError = error
        }
    }
    if (primaryError !== null) throw primaryError
}

function atomicWrite(envPath, text, replaceFile, syncParentDirectory) {
    const directory = path.dirname(envPath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = path.join(
        directory,
        `.${path.basename(envPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    )
    let descriptor = null
    let primaryError = null
    try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600)
        fs.writeFileSync(descriptor, text, "utf8")
        fs.fchmodSync(descriptor, 0o600)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = null
        replaceFile(temporaryPath, envPath)
        try {
            syncParentDirectory(directory)
        } catch (error) {
            if (!isUnsupportedDirectorySyncError(error)) throw error
        }
    } catch (error) {
        primaryError = error
    }

    if (descriptor !== null) {
        try {
            fs.closeSync(descriptor)
        } catch (error) {
            if (primaryError === null) primaryError = error
        }
    }
    try {
        fs.unlinkSync(temporaryPath)
    } catch (error) {
        if (error?.code !== "ENOENT" && primaryError === null) primaryError = error
    }
    if (primaryError !== null) throw primaryError
}

function isInteractiveTerminal(input, errorOutput) {
    return input?.isTTY === true && errorOutput?.isTTY === true
}

async function maybeWriteMultiHubTokenEnv({
    envPath,
    token,
    interactive,
    confirm,
    replaceFile = fs.renameSync,
    syncParentDirectory = syncParentDirectoryDefault,
}) {
    if (!interactive) return { written: false, reason: "non_interactive" }
    const originalText = readEnvFile(envPath)
    const text = originalText.charCodeAt(0) === 0xFEFF ? originalText.slice(1) : originalText
    const assignments = scanTokenAssignments(text)
    if (assignments.length > 1) {
        throw new MultiHubEnvError("DUPLICATE_MULTI_HUB_TOKEN_ENV")
    }

    const existing = assignments.length === 1
    const accepted = await confirm(existing
        ? {
            defaultValue: false,
            message: "MULTI_HUB_TOKEN already exists; default will not overwrite it. Replace it?",
        }
        : {
            defaultValue: true,
            message: "Write the new token to the project .env file?",
        })
    if (!accepted) return { written: false, reason: "declined" }

    atomicWrite(
        envPath,
        replaceToken(text, token, assignments),
        replaceFile,
        syncParentDirectory,
    )
    return { written: true, reason: existing ? "replaced" : "created" }
}

module.exports = {
    isInteractiveTerminal,
    maybeWriteMultiHubTokenEnv,
    MultiHubEnvError,
}
