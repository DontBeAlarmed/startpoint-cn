require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.join(__dirname, "..")
const sessionSource = fs.readFileSync(path.join(projectRoot, "src/data/domains/session.ts"), "utf8")
const cdnSource = fs.readFileSync(path.join(projectRoot, "src/validate_cdn.ts"), "utf8")

test("expired session logging is a token-free single-line field summary", () => {
    const expirationStart = sessionSource.indexOf("// viewer tokens don't expire.")
    const expirationEnd = sessionSource.indexOf("return session", expirationStart)
    const expirationBlock = sessionSource.slice(expirationStart, expirationEnd)
    const logStatement = expirationBlock.match(/console\.log\([^\n]+\)/)?.[0] ?? ""

    assert.match(logStatement, /\[SESSION\] expired/)
    assert.match(logStatement, /type=\$\{session\.type\}/)
    assert.match(logStatement, /accountId=\$\{session\.accountId\}/)
    assert.match(logStatement, /expires=\$\{session\.expires\.toISOString\(\)\}/)
    assert.doesNotMatch(logStatement, /token|,\s*session/)
})

test("CDN invalid locations are logged as one formatted string", () => {
    assert.match(
        cdnSource,
        /console\.log\(`Invalid and\/or missing files: \[\$\{invalidLocations\.join\(", "\)\}\]`\)/,
    )
    assert.doesNotMatch(cdnSource, /console\.log\("Invalid and\/or missing files: \[",/)
})
