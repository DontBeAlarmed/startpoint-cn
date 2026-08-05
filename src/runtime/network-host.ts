import { isIP } from "node:net"

export function isValidNetworkHost(value: unknown): value is string {
    if (typeof value !== "string"
        || value.length === 0
        || value !== value.trim()
        || /\s|[\x00-\x1f\x7f]/.test(value)) return false
    if (isIP(value) !== 0) return true
    if (value.length > 253
        || /^[0-9.]+$/.test(value)
        || !/^[A-Za-z0-9.-]+$/.test(value)) return false
    return value.split(".").every(label => (
        label.length > 0
        && label.length <= 63
        && !label.startsWith("-")
        && !label.endsWith("-")
    ))
}
