import { randomBytes } from "node:crypto"

const MULTI_HUB_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export function generateMultiHubToken(): string {
    return randomBytes(32).toString("hex")
}

export function validateMultiHubToken(value: unknown): value is string {
    return typeof value === "string" && MULTI_HUB_TOKEN_PATTERN.test(value)
}
