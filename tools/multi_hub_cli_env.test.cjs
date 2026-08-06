"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const {
    createOfflineMultiManagementService,
} = require("../src/multi/management/offline")
const {
    isInteractiveTerminal,
    maybeWriteMultiHubTokenEnv,
} = require("./lib/multi-hub-env.cjs")

const projectRoot = path.resolve(__dirname, "..")

function envFixture(t, text = "", mode = 0o600) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-env-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const envPath = path.join(root, ".env")
    if (text !== null) fs.writeFileSync(envPath, text, { mode })
    return { envPath, root }
}

function readTokenViaNodeEnvFile(envPath) {
    const env = { ...process.env }
    delete env.MULTI_HUB_TOKEN
    return spawnSync(process.execPath, [
        `--env-file=${envPath}`,
        "-e",
        "process.stdout.write(process.env.MULTI_HUB_TOKEN ?? 'missing')",
    ], { encoding: "utf8", env })
}

test("client management ignores an invalid residual Host credentials path", () => {
    const service = createOfflineMultiManagementService({
        projectRoot,
        env: {
            MULTI_MODE: "client",
            MULTI_HUB_CREDENTIALS_FILE: "relative-host-only-path.json",
        },
    })

    for (const operation of [
        () => service.createCredential("node-a"),
        () => service.listCredentials(),
        () => service.revokeCredential("a".repeat(32)),
    ]) {
        assert.throws(operation, { code: "CLIENT_MULTI_MANAGEMENT_UNAVAILABLE" })
    }
})

test("client CLI rejects every Host credential action without reading its residual path", () => {
    const residualRelativePath = `.multi-hub-client-only-${process.pid}.json`
    const residualPath = path.join(projectRoot, residualRelativePath)
    assert.equal(fs.existsSync(residualPath), false)
    for (const args of [
        ["create", "must-not-exist"],
        ["list"],
        ["revoke", "a".repeat(32)],
    ]) {
        const result = spawnSync(process.execPath, ["tools/manage_multi_hub_token.cjs", ...args], {
            cwd: projectRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                MULTI_MODE: "client",
                MULTI_HUB_CREDENTIALS_FILE: residualRelativePath,
            },
        })
        assert.equal(result.status, 1, args[0])
        assert.match(result.stderr, /CLIENT_MULTI_MANAGEMENT_UNAVAILABLE/)
    }
    assert.equal(fs.existsSync(residualPath), false)
})

test("management CLI composes through the offline adapter and uses stderr for TTY prompts", () => {
    const source = fs.readFileSync(
        path.join(projectRoot, "tools", "manage_multi_hub_token.cjs"),
        "utf8",
    )

    assert.match(source, /multi\/management\/offline/)
    assert.match(source, /isInteractiveTerminal/)
    assert.doesNotMatch(source, /multi\/hub\/credential-store/)
    assert.doesNotMatch(source, /\bstore\.(?:create|list|revoke)\s*\(/)
    assert.doesNotMatch(source, /process\.stdout\.isTTY/)
})

test("TTY interaction depends on stdin and stderr, not redirected stdout", () => {
    assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: true }), true)
    assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: false }), false)
    assert.equal(isInteractiveTerminal({ isTTY: false }, { isTTY: true }), false)
    assert.equal(isInteractiveTerminal({ isTTY: false }, { isTTY: false }), false)
})

test("interactive create appends a missing token and tightens .env permissions", async t => {
    const { envPath } = envFixture(t, "KEEP=value\n", 0o640)
    const prompts = []

    const result = await maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async question => {
            prompts.push(question)
            return question.defaultValue
        },
    })

    assert.deepEqual(result, { written: true, reason: "created" })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].defaultValue, true)
    assert.equal(fs.readFileSync(envPath, "utf8"), `KEEP=value\nMULTI_HUB_TOKEN=${"a".repeat(64)}\n`)
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600)
})

test("interactive create does not overwrite one existing token by default", async t => {
    const original = `MULTI_HUB_TOKEN=${"b".repeat(64)}\nKEEP=value\n`
    const { envPath } = envFixture(t, original)
    const prompts = []

    const result = await maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async question => {
            prompts.push(question)
            return question.defaultValue
        },
    })

    assert.deepEqual(result, { written: false, reason: "declined" })
    assert.equal(prompts[0].defaultValue, false)
    assert.match(prompts[0].message, /not overwrite|不会覆盖/i)
    assert.equal(fs.readFileSync(envPath, "utf8"), original)
})

test("scanner removes BOM while preserving comments, quotes, and CRLF", async t => {
    const oldToken = "b".repeat(64)
    const newToken = "a".repeat(64)
    const original = [
        "\uFEFF# header",
        "SINGLE='MULTI_HUB_TOKEN=fake-single'",
        "DOUBLE=\"MULTI_HUB_TOKEN=fake-double # literal\"",
        `export MULTI_HUB_TOKEN = \"${oldToken}\" # keep this comment`,
        "TAIL=value",
        "",
    ].join("\r\n")
    const { envPath } = envFixture(t, original)

    await maybeWriteMultiHubTokenEnv({
        envPath,
        token: newToken,
        interactive: true,
        confirm: async () => true,
    })

    assert.equal(fs.readFileSync(envPath, "utf8"), original.slice(1).replace(oldToken, newToken))
})

test("writing removes a BOM directly before the token so Node env-file reads the real key", async t => {
    const oldToken = "b".repeat(64)
    const newToken = "a".repeat(64)
    const { envPath } = envFixture(t, `\uFEFFMULTI_HUB_TOKEN=${oldToken}\nKEEP=value\n`)

    await maybeWriteMultiHubTokenEnv({
        envPath,
        token: newToken,
        interactive: true,
        confirm: async () => true,
    })

    assert.equal(
        fs.readFileSync(envPath, "utf8"),
        `MULTI_HUB_TOKEN=${newToken}\nKEEP=value\n`,
    )
    const loaded = readTokenViaNodeEnvFile(envPath)
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.equal(loaded.stdout, newToken)
})

test("scanner ignores token-looking text inside a multiline quoted value", async t => {
    const oldToken = "b".repeat(64)
    const newToken = "a".repeat(64)
    const original = [
        "PAYLOAD=\"first line",
        "MULTI_HUB_TOKEN=fake-inside-value",
        "last line\"",
        `MULTI_HUB_TOKEN='${oldToken}'`,
        "TAIL=value",
        "",
    ].join("\n")
    const { envPath } = envFixture(t, original)

    await maybeWriteMultiHubTokenEnv({
        envPath,
        token: newToken,
        interactive: true,
        confirm: async () => true,
    })

    assert.equal(fs.readFileSync(envPath, "utf8"), original.replace(oldToken, newToken))
})

test("scanner ignores token-looking text inside a multiline backtick value", async t => {
    const oldToken = "b".repeat(64)
    const newToken = "a".repeat(64)
    const original = [
        "PAYLOAD=`first line",
        "MULTI_HUB_TOKEN=fake-inside-backticks",
        "last line`",
        `MULTI_HUB_TOKEN=${oldToken}`,
        "TAIL=value",
        "",
    ].join("\n")
    const { envPath } = envFixture(t, original)

    await maybeWriteMultiHubTokenEnv({
        envPath,
        token: newToken,
        interactive: true,
        confirm: async () => true,
    })

    assert.equal(fs.readFileSync(envPath, "utf8"), original.replace(oldToken, newToken))
})

test("scanner rejects duplicate top-level tokens but ignores quoted and commented lookalikes", async t => {
    const original = [
        "# MULTI_HUB_TOKEN=commented",
        "PAYLOAD=\"MULTI_HUB_TOKEN=fake\"",
        `MULTI_HUB_TOKEN=${"b".repeat(64)}`,
        `export MULTI_HUB_TOKEN='${"c".repeat(64)}'`,
        "",
    ].join("\n")
    const { envPath } = envFixture(t, original)
    let prompted = false

    await assert.rejects(maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async () => {
            prompted = true
            return true
        },
    }), { code: "DUPLICATE_MULTI_HUB_TOKEN_ENV" })
    assert.equal(prompted, false)
    assert.equal(fs.readFileSync(envPath, "utf8"), original)
})

test("scanner rejects an unterminated top-level quoted value", async t => {
    const original = `MULTI_HUB_TOKEN=\"${"b".repeat(64)}\n`
    const { envPath } = envFixture(t, original)

    await assert.rejects(maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async () => true,
    }), { code: "INVALID_MULTI_HUB_ENV_FILE" })
    assert.equal(fs.readFileSync(envPath, "utf8"), original)
})

test("non-interactive create never prompts or writes .env", async t => {
    const { envPath } = envFixture(t, null)
    let prompted = false

    const result = await maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: false,
        confirm: async () => {
            prompted = true
            return true
        },
    })

    assert.deepEqual(result, { written: false, reason: "non_interactive" })
    assert.equal(prompted, false)
    assert.equal(fs.existsSync(envPath), false)
})

test("atomic replacement EIO preserves the original and removes only its current temp file", async t => {
    const original = "KEEP=value\n"
    const { envPath, root } = envFixture(t, original)
    const staleTemporaryPath = path.join(root, ".env.stale.tmp")
    fs.writeFileSync(staleTemporaryPath, "stale", { mode: 0o600 })

    await assert.rejects(maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async () => true,
        replaceFile(temporaryPath) {
            assert.match(fs.readFileSync(temporaryPath, "utf8"), /MULTI_HUB_TOKEN=a{64}/)
            throw Object.assign(new Error("replace failed"), { code: "EIO" })
        },
    }), { code: "EIO" })
    assert.equal(fs.readFileSync(envPath, "utf8"), original)
    assert.equal(fs.readFileSync(staleTemporaryPath, "utf8"), "stale")
    assert.deepEqual(fs.readdirSync(root).sort(), [".env", ".env.stale.tmp"])
})

test("parent directory fsync EIO is preserved after rename and current temp cleanup", async t => {
    const { envPath, root } = envFixture(t, "KEEP=value\n")
    const failure = Object.assign(new Error("directory fsync failed"), { code: "EIO" })

    await assert.rejects(maybeWriteMultiHubTokenEnv({
        envPath,
        token: "a".repeat(64),
        interactive: true,
        confirm: async () => true,
        syncParentDirectory: () => { throw failure },
    }), error => error === failure)
    assert.match(fs.readFileSync(envPath, "utf8"), /MULTI_HUB_TOKEN=a{64}/)
    assert.deepEqual(fs.readdirSync(root), [".env"])
})

test("only unsupported parent directory fsync errors are ignored", async t => {
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP"]) {
        const { envPath } = envFixture(t, "KEEP=value\n")
        await maybeWriteMultiHubTokenEnv({
            envPath,
            token: "a".repeat(64),
            interactive: true,
            confirm: async () => true,
            syncParentDirectory: () => {
                throw Object.assign(new Error(`directory fsync ${code}`), { code })
            },
        })
        assert.equal(fs.statSync(envPath).mode & 0o777, 0o600)
    }
})
