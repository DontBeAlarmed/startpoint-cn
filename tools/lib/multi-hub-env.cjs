"use strict"

const { randomBytes } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const TOKEN_LINE = /^[ \t]*(?:export[ \t]+)?MULTI_HUB_TOKEN[ \t]*=.*\r?$/gm
const TOKEN_PREFIX = /^([ \t]*(?:export[ \t]+)?MULTI_HUB_TOKEN[ \t]*=)/

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
        return { text: fs.readFileSync(envPath, "utf8"), mode: stats.mode & 0o777 }
    } catch (error) {
        if (error?.code === "ENOENT") return { text: "", mode: 0o600 }
        throw error
    }
}

function replaceToken(text, token, matches) {
    if (matches.length === 1) {
        return text.replace(TOKEN_LINE, line => {
            const prefix = line.match(TOKEN_PREFIX)?.[1] ?? "MULTI_HUB_TOKEN="
            return `${prefix}${token}${line.endsWith("\r") ? "\r" : ""}`
        })
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n"
    const separator = text.length === 0 || text.endsWith("\n") ? "" : newline
    return `${text}${separator}MULTI_HUB_TOKEN=${token}${newline}`
}

function atomicWrite(envPath, text, mode, replaceFile) {
    const directory = path.dirname(envPath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = path.join(
        directory,
        `.${path.basename(envPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    )
    let descriptor = null
    try {
        descriptor = fs.openSync(temporaryPath, "wx", mode)
        fs.writeFileSync(descriptor, text, "utf8")
        fs.fchmodSync(descriptor, mode)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = null
        replaceFile(temporaryPath, envPath)
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor)
        try {
            fs.unlinkSync(temporaryPath)
        } catch (error) {
            if (error?.code !== "ENOENT") throw error
        }
    }
}

async function maybeWriteMultiHubTokenEnv({
    envPath,
    token,
    interactive,
    confirm,
    replaceFile = fs.renameSync,
}) {
    if (!interactive) return { written: false, reason: "non_interactive" }
    const { text, mode } = readEnvFile(envPath)
    const matches = [...text.matchAll(TOKEN_LINE)]
    if (matches.length > 1) throw new MultiHubEnvError("DUPLICATE_MULTI_HUB_TOKEN_ENV")

    const existing = matches.length === 1
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

    atomicWrite(envPath, replaceToken(text, token, matches), mode, replaceFile)
    return { written: true, reason: existing ? "replaced" : "created" }
}

module.exports = {
    maybeWriteMultiHubTokenEnv,
    MultiHubEnvError,
}
