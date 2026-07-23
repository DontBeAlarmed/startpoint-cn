"use strict"

const { createHash } = require("node:crypto")

function invalid(path, reason) {
    throw new TypeError(`${path} is not canonical JSON: ${reason}`)
}

function encode(value, valuePath, ancestors) {
    if (value === null) return "null"

    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value)
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalid(valuePath, "number must be finite")
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            invalid(valuePath, "integer must be safe")
        }
        return JSON.stringify(value)
    }
    if (typeof value !== "object") invalid(valuePath, `unsupported ${typeof value}`)
    if (ancestors.has(value)) invalid(valuePath, "cyclic reference")
    ancestors.add(value)

    try {
        if (Array.isArray(value)) {
            const values = value.map((item, index) => encode(item, `${valuePath}[${index}]`, ancestors))
            if (values.length !== value.length) invalid(valuePath, "sparse array")
            return `[${values.join(",")}]`
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            invalid(valuePath, "object must be plain")
        }
        const keys = Object.keys(value).sort()
        if (Reflect.ownKeys(value).length !== keys.length) {
            invalid(valuePath, "properties must be enumerable string keys")
        }
        return `{${keys.map(key => (
            `${JSON.stringify(key)}:${encode(value[key], `${valuePath}.${key}`, ancestors)}`
        )).join(",")}}`
    } finally {
        ancestors.delete(value)
    }
}

function canonicalJsonBuffer(value) {
    return Buffer.from(`${encode(value, "$", new WeakSet())}\n`, "utf8")
}

function sha256Hex(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("bytes must be a Buffer")
    return createHash("sha256").update(bytes).digest("hex")
}

module.exports = { canonicalJsonBuffer, sha256Hex }
