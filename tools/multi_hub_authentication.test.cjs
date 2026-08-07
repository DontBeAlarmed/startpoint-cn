"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const {
    AuthenticationRejectionBuffer,
    MAX_AUTHENTICATION_REJECTIONS,
} = require("../src/multi/hub/authentication-rejections")
const {
    MultiHubCredentialStore,
} = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")

function authenticationFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-authentication-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "private", "credentials.json")
    const tokens = ["a".repeat(64), "b".repeat(64)]
    const credentialIds = ["1".repeat(32), "2".repeat(32)]
    let timestamp = Date.parse("2026-08-07T00:00:00.000Z")
    const store = new MultiHubCredentialStore({
        credentialsPath,
        generateCredentialId: () => credentialIds.shift(),
        generateToken: () => tokens.shift(),
        now: () => new Date(timestamp++),
    })
    const revoked = store.create("revoked-node")
    const active = store.create("active-node")
    store.revoke(revoked.credentialId)
    const reloader = new CredentialReloader({ credentialsPath, warn: () => {} })
    assert.equal(reloader.reloadIfChanged(), true)
    return { active, credentialsPath, reloader, revoked }
}

test("credential reloader classifies malformed, unknown, revoked, and active tokens", t => {
    const { active, reloader, revoked } = authenticationFixture(t)

    assert.deepEqual(reloader.authenticateDetailed(null), {
        ok: false,
        reason: "malformed",
    })
    assert.deepEqual(reloader.authenticateDetailed("short"), {
        ok: false,
        reason: "malformed",
    })
    assert.deepEqual(reloader.authenticateDetailed("c".repeat(64)), {
        ok: false,
        reason: "unknown",
    })
    assert.deepEqual(reloader.authenticateDetailed(revoked.token), {
        ok: false,
        reason: "revoked",
        credentialId: revoked.credentialId,
    })
    assert.deepEqual(reloader.authenticateDetailed(active.token), {
        ok: true,
        credential: {
            credentialId: active.credentialId,
            label: active.label,
            createdAt: active.createdAt,
            revokedAt: null,
        },
    })
})

test("legacy authenticate keeps returning only active credentials", t => {
    const { active, reloader, revoked } = authenticationFixture(t)

    assert.equal(reloader.authenticate("short"), null)
    assert.equal(reloader.authenticate("c".repeat(64)), null)
    assert.equal(reloader.authenticate(revoked.token), null)
    assert.equal(reloader.authenticate(active.token)?.credentialId, active.credentialId)
})

test("authentication rejection event type requires credential IDs only for revoked", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-authentication-types-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sourcePath = path.join(root, "contract.ts")
    const targetPath = path.join(projectRoot, "src/multi/hub/authentication-rejections")
    const relativeTarget = path.relative(root, targetPath).replaceAll(path.sep, "/")
    const importTarget = relativeTarget.startsWith(".") ? relativeTarget : `./${relativeTarget}`
    fs.writeFileSync(sourcePath, `
import type { AuthenticationRejectionEvent } from ${JSON.stringify(importTarget)}

// @ts-expect-error revoked events require a credential ID
const missingRevokedId: AuthenticationRejectionEvent = {
    timestamp: "2026-08-07T12:00:00.000Z",
    reason: "revoked",
}

// @ts-expect-error unknown events cannot carry a credential ID
const unknownWithId: AuthenticationRejectionEvent = {
    timestamp: "2026-08-07T12:00:00.000Z",
    reason: "unknown",
    credentialId: "forbidden",
}

void missingRevokedId
void unknownWithId
`, "utf8")

    const result = spawnSync(process.execPath, [
        path.join(projectRoot, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "commonjs",
        "--moduleResolution",
        "node",
        "--target",
        "es2016",
        sourcePath,
    ], { cwd: projectRoot, encoding: "utf8" })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test("unknown and revoked authentication scan every credential digest", t => {
    const { credentialsPath, reloader, revoked } = authenticationFixture(t)
    const persisted = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
    assert.equal(persisted.credentials[0].credentialId, revoked.credentialId)

    const originalTimingSafeEqual = crypto.timingSafeEqual
    let comparisons = 0
    const snapshotSize = reloader.getStatus().total
    crypto.timingSafeEqual = (...args) => {
        comparisons++
        return originalTimingSafeEqual(...args)
    }
    try {
        assert.deepEqual(reloader.authenticateDetailed("c".repeat(64)), {
            ok: false,
            reason: "unknown",
        })
        assert.equal(comparisons, snapshotSize)

        comparisons = 0
        assert.deepEqual(reloader.authenticateDetailed(revoked.token), {
            ok: false,
            reason: "revoked",
            credentialId: revoked.credentialId,
        })
        assert.equal(comparisons, snapshotSize)
    } finally {
        crypto.timingSafeEqual = originalTimingSafeEqual
    }

    assert.equal(crypto.timingSafeEqual, originalTimingSafeEqual)
})

test("authentication rejection buffer keeps a frozen sanitized 32-event FIFO", () => {
    assert.equal(MAX_AUTHENTICATION_REJECTIONS, 32)
    let timestamp = Date.parse("2026-08-07T12:00:00.000Z")
    const buffer = new AuthenticationRejectionBuffer(() => timestamp++)

    for (let index = 0; index < 34; index++) {
        const reason = index % 3 === 0 ? "revoked" : index % 3 === 1 ? "unknown" : "malformed"
        const rejection = reason === "revoked"
            ? {
                reason,
                credentialId: index.toString(16).padStart(32, "0"),
                token: `secret-${index}`,
                tokenDigest: `digest-${index}`,
            }
            : {
                reason,
                credentialId: `forbidden-${index}`,
                request: { address: "forbidden", sessionId: `session-${index}` },
            }
        buffer.record(rejection)
    }

    const firstList = buffer.list()
    const secondList = buffer.list()
    assert.equal(firstList.length, 32)
    assert.equal(firstList[0].timestamp, "2026-08-07T12:00:00.002Z")
    assert.equal(firstList.at(-1).timestamp, "2026-08-07T12:00:00.033Z")
    assert.notEqual(firstList, secondList)
    assert.equal(Object.isFrozen(firstList), true)
    assert.equal(firstList.every(Object.isFrozen), true)
    assert.throws(() => firstList.push({
        timestamp: "1970-01-01T00:00:00.000Z",
        reason: "unknown",
    }), TypeError)
    assert.throws(() => { firstList[0].reason = "unknown" }, TypeError)

    for (const event of firstList) {
        assert.equal(Object.hasOwn(event, "credentialId"), event.reason === "revoked")
    }
    const serialized = JSON.stringify(firstList)
    for (const forbidden of [
        "token",
        "digest",
        "request",
        "address",
        "device",
        "session",
    ]) {
        assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden)
    }
})
