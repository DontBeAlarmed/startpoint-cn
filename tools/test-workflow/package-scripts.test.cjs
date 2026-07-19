const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "../..")
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const cnTsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.cn.json"), "utf8"))
const { scripts } = packageJson

const tsc = "node --max-old-space-size=4096 node_modules/typescript/bin/tsc"

test("runs typecheck through Node with the project memory limit", () => {
    assert.equal(scripts.typecheck, `${tsc} --noEmit`)
})

test("keeps CN server and legacy builds separate", () => {
    assert.equal(
        scripts["build:server"],
        `${tsc} -p tsconfig.cn.json && node tools/test-workflow/verify-cn-build.cjs`,
    )
    assert.equal(scripts["build:legacy"], `${tsc} -p tsconfig.json`)
    assert.doesNotMatch(scripts["build:server"], /admin|css/)
})

test("includes runtime-loaded CN modules as explicit compilation roots", () => {
    assert.deepEqual(cnTsconfig.files, [
        "src/cn-server.ts",
        "src/multi/tcp/lobby.ts",
    ])
})

test("builds the CN development server before starting it", () => {
    assert.equal(
        scripts["dev:cn"],
        "npm run build:server && node --env-file=.env out/cn-server.js",
    )
})

test("separates reproducible admin installation from its build", () => {
    assert.equal(scripts["install:admin"], "npm --prefix admin ci")
    assert.equal(scripts["build:admin"], "npm --prefix admin run build")
    assert.doesNotMatch(scripts["build:admin"], /\b(?:install|ci)\b/)
})

test("runs legacy CDN tools only after compilation completes", () => {
    assert.equal(
        scripts.cdn,
        "npm run build:legacy && node --env-file=.env out/validate_cdn.js",
    )
    assert.equal(
        scripts.unzip,
        "npm run build:legacy && node --env-file=.env out/unzip_cdn.js",
    )
    assert.doesNotMatch(scripts.cdn, /(?:^|\s)&(?:\s|$)/)
    assert.doesNotMatch(scripts.unzip, /(?:^|\s)&(?:\s|$)/)
})

test("defines the full verification pipeline", () => {
    assert.equal(
        scripts["verify:full"],
        "npm run typecheck && npm run test:full && npm run hygiene && npm run build:server",
    )
})
