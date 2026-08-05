"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    generateMultiHubToken,
    validateMultiHubToken,
} = require("../src/multi/hub/token")

test("server-generated Hub tokens are lowercase 32-byte hexadecimal credentials", () => {
    const token = generateMultiHubToken()

    assert.match(token, /^[0-9a-f]{64}$/)
    assert.equal(validateMultiHubToken(token), true)
})

test("Hub token validation accepts the complete URL-safe length contract", () => {
    for (const token of [
        "a".repeat(32),
        "A0_-".repeat(16),
        "z".repeat(128),
    ]) {
        assert.equal(validateMultiHubToken(token), true, token.length)
    }
})

test("Hub token validation rejects weak, malformed, and oversized values", () => {
    for (const token of [
        "",
        "123",
        "a".repeat(31),
        "a".repeat(129),
        `a${"b".repeat(31)} `,
        `a${"b".repeat(31)}.`,
        `a${"b".repeat(31)}/`,
        null,
        undefined,
    ]) {
        assert.equal(validateMultiHubToken(token), false, String(token))
    }
})
