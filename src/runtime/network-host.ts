import { isIP } from "node:net"
import os from "node:os"

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

export function isUnspecifiedNetworkHost(value: string): boolean {
    if (isIP(value) === 4) return value === "0.0.0.0"
    if (isIP(value) !== 6) return false
    return new URL(`http://[${value}]`).hostname === "[::]"
}

export interface DisplayHostOptions {
    readonly listenHost?: string
    readonly publicHost?: string
}

export function resolveDisplayHost(options: DisplayHostOptions = {}): string {
    const publicHost = options.publicHost?.trim()
    if (publicHost) return publicHost

    const listenHost = (options.listenHost ?? "127.0.0.1").trim()
    if (!isUnspecifiedNetworkHost(listenHost)) return listenHost

    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
        const addresses = nets[name]
        if (!addresses) continue
        for (const address of addresses) {
            if (address.family === "IPv4" && !address.internal) return address.address
        }
    }
    return "127.0.0.1"
}
